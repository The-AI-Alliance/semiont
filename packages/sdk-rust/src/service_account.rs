//! Signing in as a service account: the issuer's OIDC discovery, then its
//! client-credentials grant, the token kept until shortly before it expires.
//! A service reaches another as itself with this token.

use crate::identity::encode_uri_component;
use serde_json::Value;
use std::fmt;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Renew a service token this long before it expires.
const RENEW_BEFORE_EXPIRY: Duration = Duration::from_secs(30);

/// A service account at an issuer.
pub struct Credential {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
}

/// Why a service account could not be signed in. The message names the issuer
/// and the client, and never the secret.
#[derive(Debug)]
pub enum SignInError {
    /// The issuer's discovery document could not be read, or names no token endpoint.
    Discovery(String),
    /// The token endpoint refused the grant, or answered no token.
    Grant(String),
}

impl fmt::Display for SignInError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SignInError::Discovery(message) | SignInError::Grant(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for SignInError {}

/// A service account's token, fetched on first use and renewed before it expires.
pub struct ServiceToken {
    http: reqwest::Client,
    credential: Credential,
    token_endpoint: Mutex<Option<String>>,
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
        let response = self.http.get(&url).send().await.map_err(|e| {
            SignInError::Discovery(format!("OIDC discovery for {issuer} failed: {e}"))
        })?;
        if !response.status().is_success() {
            return Err(SignInError::Discovery(format!(
                "OIDC discovery for {issuer} failed: HTTP {} from {url}",
                response.status().as_u16()
            )));
        }
        let document: Value = response.json().await.map_err(|e| {
            SignInError::Discovery(format!("OIDC discovery for {issuer} is not JSON: {e}"))
        })?;
        let endpoint = document["token_endpoint"].as_str().ok_or_else(|| {
            SignInError::Discovery(format!(
                "OIDC discovery for {issuer} returned no `token_endpoint`"
            ))
        })?;
        *known = Some(endpoint.to_owned());
        Ok(endpoint.to_owned())
    }

    /// The `authorization` header value: the account's token, renewed before
    /// it expires. The grant's `expires_in` says how long it lives; without
    /// one it is not kept.
    pub async fn authorization(&self) -> Result<String, SignInError> {
        let mut held = self.token.lock().await;
        if let Some((token, expires)) = held.as_ref()
            && Instant::now() + RENEW_BEFORE_EXPIRY < *expires
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
            .send()
            .await
            .map_err(|e| {
                SignInError::Grant(format!(
                    "Client-credentials grant for {client_id} at {issuer} failed: {e}"
                ))
            })?;
        if !response.status().is_success() {
            // The status, never the body: an error body can echo the secret.
            return Err(SignInError::Grant(format!(
                "Client-credentials grant for {client_id} at {issuer} failed (HTTP {})",
                response.status().as_u16()
            )));
        }
        let body: Value = response.json().await.map_err(|e| {
            SignInError::Grant(format!(
                "Token endpoint for {issuer} did not answer JSON: {e}"
            ))
        })?;
        let token = body["access_token"]
            .as_str()
            .ok_or_else(|| {
                SignInError::Grant(format!(
                    "Token endpoint for {issuer} returned no `access_token`"
                ))
            })?
            .to_owned();
        *held = body["expires_in"]
            .as_f64()
            .filter(|s| s.is_finite())
            .map(|seconds| {
                (
                    token.clone(),
                    Instant::now() + Duration::from_secs_f64(seconds.max(0.0)),
                )
            });
        Ok(format!("Bearer {token}"))
    }
}
