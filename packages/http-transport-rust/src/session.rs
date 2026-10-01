//! An agent's session with a knowledge base's gateway: its service account's
//! token (`service_account`) exchanged at `POST /api/tokens/agent` for the
//! token of the software agent `(provider, model)`, which names the work it
//! does. The gateway decides how long the agent token lives.
//!
//! The session is a transport's token source: it gives the current token and
//! each one after it, renews the token by the schedule every Semiont client
//! keeps (`semiont::session`), and renews it at once when the gateway refuses
//! it (`TokenRefresher`).

use crate::service_account::{ServiceToken, SignInError};
use crate::transport::TokenRefresher;
use semiont::retry::{self, RetryFacts, retry_with_backoff};
use semiont::session::refresh_delay;
use semiont::timing::REFRESH_RETRY;
use semiont::transport::BoxFuture;
use semiont::types::{AgentTokenRequest, AgentTokenResponse};
use std::fmt;
use std::sync::{Arc, Weak};
use std::time::SystemTime;
use tokio::sync::watch;

/// Why the agent could not be signed in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    /// The service account could not sign in at the issuer.
    SignIn(SignInError),
    /// The gateway could not be reached.
    Unreachable(String),
    /// The gateway refused the exchange.
    Refused { status: u16 },
    /// The gateway answered something that is not an agent token.
    Malformed(String),
}

impl SessionError {
    /// What a retry rule asks of this failure.
    fn retry_facts(&self) -> RetryFacts<'static> {
        RetryFacts {
            status: match self {
                SessionError::SignIn(error) => return error.retry_facts(),
                SessionError::Unreachable(_) => None,
                SessionError::Refused { status } => Some(*status),
                SessionError::Malformed(_) => Some(200),
            },
            method: Some("POST"),
        }
    }
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SessionError::SignIn(error) => write!(f, "{error}"),
            SessionError::Unreachable(message) | SessionError::Malformed(message) => {
                f.write_str(message)
            }
            SessionError::Refused { status } => {
                write!(
                    f,
                    "the gateway refused the agent token exchange (HTTP {status})"
                )
            }
        }
    }
}

impl std::error::Error for SessionError {}

/// The agent a session acts as.
pub struct Agent {
    pub provider: String,
    pub model: String,
}

pub struct AgentSession {
    gateway: String,
    agent: Agent,
    service: ServiceToken,
    http: reqwest::Client,
    token: watch::Sender<Option<String>>,
}

impl AgentSession {
    /// Sign the agent in at `gateway`, and keep it signed in for as long as
    /// the session lives.
    pub async fn sign_in(
        gateway: &str,
        agent: Agent,
        service: ServiceToken,
        http: reqwest::Client,
    ) -> Result<Arc<AgentSession>, SessionError> {
        let session = Arc::new(AgentSession {
            gateway: gateway.trim_end_matches('/').to_owned(),
            agent,
            service,
            http,
            token: watch::channel(None).0,
        });
        session.renew().await?;
        tokio::spawn(keep_renewed(Arc::downgrade(&session)));
        Ok(session)
    }

    /// The gateway this session signs in at.
    pub fn gateway(&self) -> &str {
        &self.gateway
    }

    /// The agent token: the current one, and each one after it.
    pub fn token(&self) -> watch::Receiver<Option<String>> {
        self.token.subscribe()
    }

    /// Exchange again, and make the answer the session's token.
    async fn renew(&self) -> Result<String, SessionError> {
        let token = self.exchange().await?;
        self.token.send_replace(Some(token.clone()));
        Ok(token)
    }

    async fn exchange(&self) -> Result<String, SessionError> {
        let authorization = self
            .service
            .authorization()
            .await
            .map_err(SessionError::SignIn)?;
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
            .send()
            .await
            .map_err(|e| SessionError::Unreachable(format!("{url}: {e}")))?;
        if !response.status().is_success() {
            return Err(SessionError::Refused {
                status: response.status().as_u16(),
            });
        }
        let answer: AgentTokenResponse = response.json().await.map_err(|e| {
            SessionError::Malformed(format!("{url} did not answer an agent token: {e}"))
        })?;
        Ok(answer.token)
    }
}

impl TokenRefresher for AgentSession {
    fn refresh(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move { self.renew().await.ok() })
    }
}

/// Renew the session's token whenever it is due, until the session is gone.
/// A renewal that fails is tried again inside the renewal budget when the
/// failure is transient (`retry::REFRESH`); spent or refused, the token is
/// left as it is and the next one is due an interval later, by the schedule's
/// floor. A token that names no expiry schedules nothing: it is renewed when
/// the gateway refuses it.
async fn keep_renewed(session: Weak<AgentSession>) {
    let Some(mut token) = session.upgrade().map(|session| session.token()) else {
        return;
    };
    loop {
        let due = token
            .borrow_and_update()
            .as_deref()
            .and_then(|token| refresh_delay(token, SystemTime::now()));
        match due {
            Some(due) => {
                tokio::select! {
                    () = tokio::time::sleep(due) => {}
                    changed = token.changed() => match changed {
                        // Renewed meanwhile, by a refusal: schedule again.
                        Ok(()) => continue,
                        Err(_) => return,
                    },
                }
            }
            None => match token.changed().await {
                Ok(()) => continue,
                Err(_) => return,
            },
        }
        let Some(session) = session.upgrade() else {
            return;
        };
        let _ = retry_with_backoff(
            REFRESH_RETRY,
            || session.renew(),
            |error: &SessionError| retry::REFRESH.retryable(&error.retry_facts()),
            |_| None,
        )
        .await;
    }
}
