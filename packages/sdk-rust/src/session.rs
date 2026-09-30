//! An agent's session with a knowledge base's gateway: its service account's
//! token (`service_account`) exchanged at `POST /api/tokens/agent` for the
//! token of the software agent `(provider, model)`, which names the work it
//! does. The agent token is kept until shortly before the time its `exp`
//! claim names, then exchanged again; the gateway decides how long it lives.

use crate::service_account::{ServiceToken, SignInError};
use crate::types::{AgentTokenRequest, AgentTokenResponse};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

/// Exchange again this long before the agent token expires.
const RENEW_BEFORE_EXPIRY: Duration = Duration::from_secs(60);

/// Why the agent could not be signed in.
#[derive(Debug)]
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
    /// The agent token, and when it expires, if its `exp` says.
    held: Mutex<Option<(String, Option<SystemTime>)>>,
}

impl AgentSession {
    pub fn new(
        gateway: &str,
        agent: Agent,
        service: ServiceToken,
        http: reqwest::Client,
    ) -> AgentSession {
        AgentSession {
            gateway: gateway.trim_end_matches('/').to_owned(),
            agent,
            service,
            http,
            held: Mutex::new(None),
        }
    }

    /// The gateway this session signs in at.
    pub fn gateway(&self) -> &str {
        &self.gateway
    }

    /// The agent token: the one held, unless it expires soon.
    pub async fn token(&self) -> Result<String, SessionError> {
        let mut held = self.held.lock().await;
        if let Some((token, expires)) = held.as_ref()
            && expires.is_none_or(|at| SystemTime::now() + RENEW_BEFORE_EXPIRY < at)
        {
            return Ok(token.clone());
        }
        let token = self.exchange().await?;
        *held = Some((token.clone(), expiry(&token)));
        Ok(token)
    }

    /// Exchange again now: the gateway refused the token held.
    pub async fn refresh(&self) -> Result<String, SessionError> {
        let token = self.exchange().await?;
        *self.held.lock().await = Some((token.clone(), expiry(&token)));
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

/// When a JWT expires, by its `exp` claim; `None` when it names no time.
fn expiry(token: &str) -> Option<SystemTime> {
    let payload = token.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    let seconds = claims["exp"].as_u64()?;
    UNIX_EPOCH.checked_add(Duration::from_secs(seconds))
}
