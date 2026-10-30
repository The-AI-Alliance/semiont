//! An agent's token at a knowledge base's gateway. An agent is an account, as
//! a person is: it signs in at its issuer (`service_account`), and the token
//! its issuer grants is its bearer at the gateway. The gateway names it by
//! that account: its DID, which the gateway answers at `GET /api/users/me`,
//! is who its work is attributed to. The engine it runs is no part of it:
//! each write names that itself.
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
use crate::transport::{TokenRefresher, refuses_credential, why_unanswered};
use semiont::retry::{self, RetryFacts, retry_with_backoff};
use semiont::session::renew_when_due;
use semiont::timing::{HTTP_REQUEST_TIMEOUT, REFRESH_RETRY};
use semiont::transport::BoxFuture;
use semiont::types::{UserId, UserResponse};
use serde_json::Value;
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
    /// The gateway did not name the agent.
    Refused { status: u16 },
    /// The gateway refused the agent's token: a 401, or a 429 `refusal-rate`
    /// (docs/protocol/TRANSPORT-CONTRACT.md § A refused credential). The same
    /// token gets the same answer, so it is not tried again.
    CredentialRefused { status: u16 },
    /// The gateway answered something that names no agent.
    Malformed(String),
}

impl AgentSignInError {
    /// What a retry rule asks of this failure.
    fn retry_facts(&self) -> RetryFacts<'static> {
        RetryFacts {
            status: match self {
                AgentSignInError::SignIn(error) => return error.retry_facts(),
                AgentSignInError::Unreachable(_) => None,
                AgentSignInError::Refused { status }
                | AgentSignInError::CredentialRefused { status } => Some(*status),
                AgentSignInError::Malformed(_) => Some(200),
            },
            method: Some("GET"),
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
                write!(f, "the gateway did not name the agent (HTTP {status})")
            }
            AgentSignInError::CredentialRefused { status } => {
                write!(f, "the gateway refused the agent's token (HTTP {status})")
            }
        }
    }
}

impl std::error::Error for AgentSignInError {}

pub struct AgentToken {
    gateway: String,
    service: ServiceToken,
    did: UserId,
    token: watch::Sender<Option<String>>,
}

impl AgentToken {
    /// Sign the agent in at `gateway` as the account `service` names, and
    /// keep it signed in for as long as this is held.
    pub async fn sign_in(
        gateway: &str,
        service: ServiceToken,
        http: reqwest::Client,
    ) -> Result<Arc<AgentToken>, AgentSignInError> {
        let gateway = gateway.trim_end_matches('/').to_owned();
        let token = service
            .token(false)
            .await
            .map_err(AgentSignInError::SignIn)?;
        let did = named(&gateway, &token, &http).await?;
        let agent = Arc::new(AgentToken {
            gateway,
            service,
            did,
            token: watch::channel(Some(token)).0,
        });
        tokio::spawn(keep_renewed(Arc::downgrade(&agent), agent.token()));
        Ok(agent)
    }

    /// The agent's DID, as the gateway names its account under the knowledge
    /// base's own domain. It is carried as it came: re-derived from the URL
    /// the process happens to dial, one agent has two DIDs.
    pub fn did(&self) -> &UserId {
        &self.did
    }

    /// The gateway the agent signs in at.
    pub fn gateway(&self) -> &str {
        &self.gateway
    }

    /// The agent token: the current one, and each one after it.
    pub fn token(&self) -> watch::Receiver<Option<String>> {
        self.token.subscribe()
    }

    /// Ask the issuer for another, and make it the token.
    async fn renew(&self) -> Result<String, AgentSignInError> {
        let token = self
            .service
            .token(true)
            .await
            .map_err(AgentSignInError::SignIn)?;
        self.token.send_replace(Some(token.clone()));
        Ok(token)
    }
}

/// The DID the gateway names the bearer of `token` by: `GET /api/users/me`.
async fn named(
    gateway: &str,
    token: &str,
    http: &reqwest::Client,
) -> Result<UserId, AgentSignInError> {
    let url = format!("{gateway}/api/users/me");
    let response = http
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .timeout(HTTP_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            AgentSignInError::Unreachable(format!("{url} got no answer{}", why_unanswered(&e)))
        })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let said = response.json::<Value>().await.ok();
        return Err(if refuses_credential(status, said.as_ref()) {
            AgentSignInError::CredentialRefused { status }
        } else {
            AgentSignInError::Refused { status }
        });
    }
    let user: UserResponse = response.json().await.map_err(|e| {
        AgentSignInError::Malformed(format!("{url} did not answer who the agent is: {e}"))
    })?;
    Ok(user.did)
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
            let _ =
                retry_with_backoff(REFRESH_RETRY, || agent.renew(), worth_another, |_| None).await;
        }
    })
    .await;
}

/// Whether a renewal that failed this way is tried again inside the budget:
/// when `retry::REFRESH` calls it transient, and never when the agent's token
/// was refused, which the same token cannot change.
fn worth_another(error: &AgentSignInError) -> bool {
    !matches!(error, AgentSignInError::CredentialRefused { .. })
        && retry::REFRESH.retryable(&error.retry_facts())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_credential_is_not_renewed_again_whatever_its_status() {
        assert!(!worth_another(&AgentSignInError::CredentialRefused {
            status: 429
        }));
        assert!(!worth_another(&AgentSignInError::CredentialRefused {
            status: 401
        }));
        // A limit's 429 that refuses no credential is "not now", as before.
        assert!(worth_another(&AgentSignInError::Refused { status: 429 }));
        assert!(worth_another(&AgentSignInError::Unreachable(
            "no answer".to_owned()
        )));
        assert!(!worth_another(&AgentSignInError::Refused { status: 403 }));
    }
}
