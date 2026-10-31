//! Signing in as a service account: the issuer's OIDC discovery, then its
//! client-credentials grant, proved by the account's secret or by an
//! assertion signed with its key (`client_assertion`). The token is kept
//! until it is due for renewal by the schedule every Semiont client keeps
//! (`semiont::session`): half its lifetime before it expires, at most
//! `REFRESH_BEFORE_EXP`. A service reaches another as itself with this
//! token.

use crate::client_assertion::{JWT_BEARER, client_assertion};
use crate::transport::why_unanswered;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::signature::RsaKeyPair;
use semiont::identity::encode_uri_component;
use semiont::retry::RetryFacts;
use semiont::session::{refresh_delay, renewal_delay};
use semiont::timing::HTTP_REQUEST_TIMEOUT;
use serde_json::Value;
use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use tokio::time::Instant;
use uuid::Uuid;

/// A service account at an issuer, by how it proves itself.
#[derive(Debug)]
pub enum Credential {
    Secret(SecretCredential),
    Key(Box<KeyCredential>),
}

/// A service account at an issuer, which proves itself with its client
/// secret.
pub struct SecretCredential {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
}

/// A service account at an issuer, which proves itself with a key.
///
/// Each grant carries an assertion signed with `private_key` for that grant
/// alone, which the issuer checks with the public half registered on the
/// client. The key never leaves the process, and no secret is sent.
pub struct KeyCredential {
    pub issuer: String,
    pub client_id: String,
    pub private_key: RsaKeyPair,
}

impl fmt::Debug for SecretCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecretCredential")
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for KeyCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyCredential")
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .finish_non_exhaustive()
    }
}

impl Credential {
    fn issuer(&self) -> &str {
        match self {
            Credential::Secret(credential) => &credential.issuer,
            Credential::Key(credential) => &credential.issuer,
        }
    }

    fn client_id(&self) -> &str {
        match self {
            Credential::Secret(credential) => &credential.client_id,
            Credential::Key(credential) => &credential.client_id,
        }
    }

    /// The client-credentials grant's form: the secret itself, or an
    /// assertion signed for this grant alone.
    fn proof(&self, token_endpoint: &str) -> Result<String, SignInError> {
        match self {
            Credential::Secret(SecretCredential {
                client_id,
                client_secret,
                ..
            }) => Ok(format!(
                "grant_type=client_credentials&client_id={}&client_secret={}",
                encode_uri_component(client_id),
                encode_uri_component(client_secret)
            )),
            Credential::Key(credential) => {
                let KeyCredential {
                    issuer,
                    client_id,
                    private_key,
                } = credential.as_ref();
                let issued_at = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| {
                        SignInError::Unsigned(format!(
                            "The assertion for {client_id} at {issuer} cannot say when it was made: the system clock is before 1970"
                        ))
                    })?
                    .as_secs();
                let jti = Uuid::new_v4().simple().to_string();
                let assertion = client_assertion(
                    private_key,
                    client_id,
                    token_endpoint,
                    issued_at,
                    &jti,
                )
                .map_err(|_| {
                    SignInError::Unsigned(format!(
                        "The assertion for {client_id} at {issuer} could not be signed with its key"
                    ))
                })?;
                Ok(format!(
                    "grant_type=client_credentials&client_assertion_type={}&client_assertion={}",
                    encode_uri_component(JWT_BEARER),
                    encode_uri_component(&assertion)
                ))
            }
        }
    }
}

/// Why a PEM is not a key a service account signs with. Neither says
/// anything of what the PEM holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyError {
    /// Not an unencrypted PKCS#8 PEM private key: not armoured as
    /// `PRIVATE KEY`, or not base64 within.
    NotPkcs8Pem,
    /// A PKCS#8 key that is not an RSA key ring signs with, for the reason
    /// ring gives.
    NotRsa(String),
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyError::NotPkcs8Pem => f.write_str(
                "not an unencrypted PKCS#8 PEM private key (-----BEGIN PRIVATE KEY-----)",
            ),
            KeyError::NotRsa(reason) => {
                write!(f, "not an RSA key to sign assertions with RS256 ({reason})")
            }
        }
    }
}

impl std::error::Error for KeyError {}

const PEM_BEGIN: &str = "-----BEGIN PRIVATE KEY-----";
const PEM_END: &str = "-----END PRIVATE KEY-----";

/// The RSA key of an unencrypted PKCS#8 PEM, `-----BEGIN PRIVATE KEY-----`:
/// how a worker is handed its key, as `SEMIONT_OIDC_CLIENT_KEY`.
pub fn private_key_from_pem(pem: &str) -> Result<RsaKeyPair, KeyError> {
    let armoured = pem
        .trim()
        .strip_prefix(PEM_BEGIN)
        .and_then(|rest| rest.strip_suffix(PEM_END))
        .ok_or(KeyError::NotPkcs8Pem)?;
    let base64: String = armoured
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    let der = STANDARD.decode(base64).map_err(|_| KeyError::NotPkcs8Pem)?;
    RsaKeyPair::from_pkcs8(&der).map_err(|rejected| KeyError::NotRsa(rejected.to_string()))
}

/// Why a service account could not be signed in. The message names the issuer
/// and the client, and never the secret, the key or the assertion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInError {
    /// The issuer could not be reached.
    Unreachable(String),
    /// The issuer answered, and refused.
    Refused { status: u16, message: String },
    /// The issuer answered something that is not what was asked for.
    Malformed(String),
    /// The grant's assertion could not be made, so the issuer was not asked.
    Unsigned(String),
}

impl SignInError {
    /// What a retry rule asks of this failure. An answer that was not a
    /// refusal is still the issuer's answer: its status is the one it gave.
    pub fn retry_facts(&self) -> RetryFacts<'static> {
        RetryFacts {
            status: match self {
                SignInError::Unreachable(_) | SignInError::Unsigned(_) => None,
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
            | SignInError::Malformed(message)
            | SignInError::Unsigned(message) => f.write_str(message),
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
        let issuer = self.credential.issuer();
        let base = if issuer.ends_with('/') {
            issuer.to_owned()
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
    /// is due.
    pub async fn authorization(&self) -> Result<String, SignInError> {
        Ok(format!("Bearer {}", self.token(false).await?))
    }

    /// The account's token: the one held until it is due, and a new grant
    /// after, or at once when `renewed`. Its own `exp` and `iat` say how long
    /// it lives, or failing those the grant's `expires_in`; a token that says
    /// neither is not kept.
    pub async fn token(&self, renewed: bool) -> Result<String, SignInError> {
        let mut held = self.token.lock().await;
        if !renewed
            && let Some((token, until)) = held.as_ref()
            && Instant::now() < *until
        {
            return Ok(token.clone());
        }
        let endpoint = self.token_endpoint().await?;
        let (issuer, client_id) = (self.credential.issuer(), self.credential.client_id());
        let form = self.credential.proof(&endpoint)?;
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
            // The status, never the body: an error body can echo the secret
            // or the assertion.
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
        Ok(token)
    }
}
