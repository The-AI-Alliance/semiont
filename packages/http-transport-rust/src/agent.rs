//! An agent's token at a knowledge base's gateway: its service account's
//! token (`service_account`) exchanged at `POST /api/tokens/agent` for the
//! token of the software agent `(provider, model)`, which names the work it
//! does. The gateway decides how long the agent token lives.
//!
//! It is a transport's token source, as a person's stored sign-in is: it
//! gives the current token and each one after it, renews the token by the
//! schedule every Semiont client keeps (`semiont::session`), and renews it at
//! once when the gateway refuses it (`TokenRefresher`).
//!
//! It is not a session. A person whose token cannot be renewed is signed
//! out, and signs in again. An agent whose renewal fails keeps the token it
//! has and tries again: a process holding a token that still works does not
//! stop working over one bad round trip.

use crate::service_account::{ServiceToken, SignInError};
use crate::transport::{TokenRefresher, why_unanswered};
use semiont::retry::{self, RetryFacts, retry_with_backoff};
use semiont::session::renew_when_due;
use semiont::timing::{HTTP_REQUEST_TIMEOUT, REFRESH_RETRY};
use semiont::transport::BoxFuture;
use semiont::types::{AgentTokenRequest, AgentTokenResponse};
use std::fmt;
use std::sync::{Arc, Weak};
use tokio::sync::watch;

/// Why the agent could not be signed in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentSignInError {
    /// The service account could not sign in at the issuer.
    SignIn(SignInError),
    /// The gateway could not be reached.
    Unreachable(String),
    /// The gateway refused the exchange.
    Refused { status: u16 },
    /// The gateway answered something that is not an agent token.
    Malformed(String),
}

impl AgentSignInError {
    /// What a retry rule asks of this failure.
    fn retry_facts(&self) -> RetryFacts<'static> {
        RetryFacts {
            status: match self {
                AgentSignInError::SignIn(error) => return error.retry_facts(),
                AgentSignInError::Unreachable(_) => None,
                AgentSignInError::Refused { status } => Some(*status),
                AgentSignInError::Malformed(_) => Some(200),
            },
            method: Some("POST"),
        }
    }
}

impl fmt::Display for AgentSignInError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AgentSignInError::SignIn(error) => write!(f, "{error}"),
            AgentSignInError::Unreachable(message) | AgentSignInError::Malformed(message) => {
                f.write_str(message)
            }
            AgentSignInError::Refused { status } => {
                write!(
                    f,
                    "the gateway refused the agent token exchange (HTTP {status})"
                )
            }
        }
    }
}

impl std::error::Error for AgentSignInError {}

/// The agent a token is for.
pub struct Agent {
    pub provider: String,
    pub model: String,
}

pub struct AgentToken {
    gateway: String,
    agent: Agent,
    service: ServiceToken,
    http: reqwest::Client,
    token: watch::Sender<Option<String>>,
}

impl AgentToken {
    /// Sign the agent in at `gateway`, and keep it signed in for as long as
    /// this is held.
    pub async fn sign_in(
        gateway: &str,
        agent: Agent,
        service: ServiceToken,
        http: reqwest::Client,
    ) -> Result<Arc<AgentToken>, AgentSignInError> {
        let agent = Arc::new(AgentToken {
            gateway: gateway.trim_end_matches('/').to_owned(),
            agent,
            service,
            http,
            token: watch::channel(None).0,
        });
        agent.renew().await?;
        tokio::spawn(keep_renewed(Arc::downgrade(&agent), agent.token()));
        Ok(agent)
    }

    /// The gateway the agent signs in at.
    pub fn gateway(&self) -> &str {
        &self.gateway
    }

    /// The agent token: the current one, and each one after it.
    pub fn token(&self) -> watch::Receiver<Option<String>> {
        self.token.subscribe()
    }

    /// Exchange again, and make the answer the token.
    async fn renew(&self) -> Result<String, AgentSignInError> {
        let token = self.exchange().await?;
        self.token.send_replace(Some(token.clone()));
        Ok(token)
    }

    async fn exchange(&self) -> Result<String, AgentSignInError> {
        let authorization = self
            .service
            .authorization()
            .await
            .map_err(AgentSignInError::SignIn)?;
        let body = AgentTokenRequest {
            provider: self.agent.provider.clone(),
            model: self.agent.model.clone(),
        };
        let url = format!("{}/api/tokens/agent", self.gateway);
        let response = self
            .http
            .post(&url)
            .header("authorization", authorization)
            .json(&body)
            .timeout(HTTP_REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|e| {
                AgentSignInError::Unreachable(format!("{url} got no answer{}", why_unanswered(&e)))
            })?;
        if !response.status().is_success() {
            return Err(AgentSignInError::Refused {
                status: response.status().as_u16(),
            });
        }
        let answer: AgentTokenResponse = response.json().await.map_err(|e| {
            AgentSignInError::Malformed(format!("{url} did not answer an agent token: {e}"))
        })?;
        Ok(answer.token)
    }
}

impl TokenRefresher for AgentToken {
    fn refresh(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move { self.renew().await.ok() })
    }
}

/// Renew the token whenever it is due, for as long as it is held. A renewal
/// that fails is tried again inside the renewal budget when the failure is
/// transient (`retry::REFRESH`); spent or refused, the token is left as it is
/// and the next one is due an interval later, by the schedule's floor.
async fn keep_renewed(agent: Weak<AgentToken>, token: watch::Receiver<Option<String>>) {
    renew_when_due(token, move || {
        let agent = agent.clone();
        async move {
            let Some(agent) = agent.upgrade() else {
                return;
            };
            let _ = retry_with_backoff(
                REFRESH_RETRY,
                || agent.renew(),
                |error: &AgentSignInError| retry::REFRESH.retryable(&error.retry_facts()),
                |_| None,
            )
            .await;
        }
    })
    .await;
}
