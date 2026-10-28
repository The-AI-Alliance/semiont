//! Signing in as a service account: the issuer's OIDC discovery, then its
//! client-credentials grant. The token is kept until it is due for renewal
//! by the schedule every Semiont client keeps (`semiont::session`): half its
//! lifetime before it expires, at most `REFRESH_BEFORE_EXP`. A service
//! reaches another as itself with this token.

use crate::transport::why_unanswered;
use semiont::identity::encode_uri_component;
use semiont::retry::RetryFacts;
use semiont::session::{refresh_delay, renewal_delay};
use semiont::timing::HTTP_REQUEST_TIMEOUT;
use serde_json::Value;
use std::fmt;
use std::time::{Duration, SystemTime};
use tokio::sync::Mutex;
use tokio::time::Instant;

/// A service account at an issuer.
pub struct Credential {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
}

/// Why a service account could not be signed in. The message names the issuer
/// and the client, and never the secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInError {
    /// The issuer could not be reached.
    Unreachable(String),
    /// The issuer answered, and refused.
    Refused { status: u16, message: String },
    /// The issuer answered something that is not what was asked for.
    Malformed(String),
}

impl SignInError {
    /// What a retry rule asks of this failure. An answer that was not a
    /// refusal is still the issuer's answer: its status is the one it gave.
    pub fn retry_facts(&self) -> RetryFacts<'static> {
        RetryFacts {
            status: match self {
                SignInError::Unreachable(_) => None,
                SignInError::Refused { status, .. } => Some(*status),
                SignInError::Malformed(_) => Some(200),
            },
            method: Some("POST"),
        }
    }
}

impl fmt::Display for SignInError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SignInError::Unreachable(message)
            | SignInError::Refused { message, .. }
            | SignInError::Malformed(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for SignInError {}

/// A service account's token, fetched on first use and renewed when it is due.
pub struct ServiceToken {
    http: reqwest::Client,
    credential: Credential,
    token_endpoint: Mutex<Option<String>>,
    /// The token, and until when it is used.
    token: Mutex<Option<(String, Instant)>>,
}

impl ServiceToken {
    pub fn new(credential: Credential, http: reqwest::Client) -> ServiceToken {
        ServiceToken {
            http,
            credential,
            token_endpoint: Mutex::new(None),
            token: Mutex::new(None),
        }
    }

    async fn token_endpoint(&self) -> Result<String, SignInError> {
        let mut known = self.token_endpoint.lock().await;
        if let Some(endpoint) = known.as_ref() {
            return Ok(endpoint.clone());
        }
        let issuer = &self.credential.issuer;
        let base = if issuer.ends_with('/') {
            issuer.clone()
        } else {
            format!("{issuer}/")
        };
        let url = format!("{base}.well-known/openid-configuration");
        let response = self
            .http
            .get(&url)
            .timeout(HTTP_REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|e| {
                SignInError::Unreachable(format!(
                    "OIDC discovery for {issuer} got no answer{}",
                    why_unanswered(&e)
                ))
            })?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            return Err(SignInError::Refused {
                status,
                message: format!("OIDC discovery for {issuer} failed: HTTP {status} from {url}"),
            });
        }
        let document: Value = response.json().await.map_err(|e| {
            SignInError::Malformed(format!("OIDC discovery for {issuer} is not JSON: {e}"))
        })?;
        let endpoint = document["token_endpoint"].as_str().ok_or_else(|| {
            SignInError::Malformed(format!(
                "OIDC discovery for {issuer} returned no `token_endpoint`"
            ))
        })?;
        *known = Some(endpoint.to_owned());
        Ok(endpoint.to_owned())
    }

    /// The `authorization` header value: the account's token, renewed when it
    /// is due. Its own `exp` and `iat` say how long it lives, or failing
    /// those the grant's `expires_in`; a token that says neither is not kept.
    pub async fn authorization(&self) -> Result<String, SignInError> {
        let mut held = self.token.lock().await;
        if let Some((token, until)) = held.as_ref()
            && Instant::now() < *until
        {
            return Ok(format!("Bearer {token}"));
        }
        let endpoint = self.token_endpoint().await?;
        let Credential {
            issuer,
            client_id,
            client_secret,
        } = &self.credential;
        let form = format!(
            "grant_type=client_credentials&client_id={}&client_secret={}",
            encode_uri_component(client_id),
            encode_uri_component(client_secret)
        );
        let response = self
            .http
            .post(&endpoint)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form)
            .timeout(HTTP_REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|e| {
                SignInError::Unreachable(format!(
                    "Client-credentials grant for {client_id} at {issuer} got no answer{}",
                    why_unanswered(&e)
                ))
            })?;
        if !response.status().is_success() {
            // The status, never the body: an error body can echo the secret.
            let status = response.status().as_u16();
            return Err(SignInError::Refused {
                status,
                message: format!(
                    "Client-credentials grant for {client_id} at {issuer} failed (HTTP {status})"
                ),
            });
        }
        let body: Value = response.json().await.map_err(|e| {
            SignInError::Malformed(format!(
                "Token endpoint for {issuer} did not answer JSON: {e}"
            ))
        })?;
        let token = body["access_token"]
            .as_str()
            .ok_or_else(|| {
                SignInError::Malformed(format!(
                    "Token endpoint for {issuer} returned no `access_token`"
                ))
            })?
            .to_owned();
        let stated = body["expires_in"]
            .as_f64()
            .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
            .map(Duration::from_secs_f64);
        // Used until it is due for renewal, and never past its expiry: the
        // schedule's floor is for a timer, which a token already expired
        // must not turn into a loop, and nothing here loops.
        let renew_in = refresh_delay(&token, SystemTime::now())
            .or_else(|| stated.map(|lifetime| renewal_delay(lifetime, lifetime)));
        *held = renew_in.map(|renew_in| {
            let used_for = stated.map_or(renew_in, |lifetime| renew_in.min(lifetime));
            (token.clone(), Instant::now() + used_for)
        });
        Ok(format!("Bearer {token}"))
    }
}
