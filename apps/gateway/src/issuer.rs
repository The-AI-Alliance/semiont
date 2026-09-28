//! Verifies tokens from the one issuer the knowledge base trusts, against the
//! keys it publishes: discovery read once, the key set fetched on first use,
//! refetched when it is ten minutes old, and on a key id it does not hold no
//! more often than every thirty seconds.

use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const REFETCH_COOLDOWN: Duration = Duration::from_secs(30);
const MAX_AGE: Duration = Duration::from_secs(600);

pub struct IssuerVerifier {
    issuer: String,
    audience: String,
    http: reqwest::Client,
    jwks_uri: Mutex<Option<String>>,
    keys: Mutex<Option<KeySet>>,
}

struct KeySet {
    keys: Vec<Value>,
    fetched: Instant,
}

impl IssuerVerifier {
    pub fn new(issuer: String, audience: String, http: reqwest::Client) -> IssuerVerifier {
        IssuerVerifier {
            issuer,
            audience,
            http,
            jwks_uri: Mutex::new(None),
            keys: Mutex::new(None),
        }
    }

    /// What a token's `iss` must equal.
    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    /// What a token's `aud` must carry.
    pub fn audience(&self) -> &str {
        &self.audience
    }

    async fn discover(&self) -> Result<String, String> {
        let mut known = self.jwks_uri.lock().await;
        if let Some(uri) = known.as_ref() {
            return Ok(uri.clone());
        }
        let base = if self.issuer.ends_with('/') {
            self.issuer.clone()
        } else {
            format!("{}/", self.issuer)
        };
        let url = format!("{base}.well-known/openid-configuration");
        let response = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("OIDC discovery for {} failed: {e}", self.issuer))?;
        if !response.status().is_success() {
            return Err(format!(
                "OIDC discovery for {} failed: HTTP {} from {url}",
                self.issuer,
                response.status().as_u16()
            ));
        }
        let document: Value = response
            .json()
            .await
            .map_err(|e| format!("OIDC discovery for {} is not JSON: {e}", self.issuer))?;
        let (Some(issuer), Some(jwks_uri)) =
            (document["issuer"].as_str(), document["jwks_uri"].as_str())
        else {
            return Err(format!(
                "OIDC discovery for {} returned a document without `issuer` and `jwks_uri`",
                self.issuer
            ));
        };
        if issuer != self.issuer {
            return Err(format!(
                "OIDC discovery for {} names a different issuer: {issuer}",
                self.issuer
            ));
        }
        *known = Some(jwks_uri.to_owned());
        Ok(jwks_uri.to_owned())
    }

    async fn fetch(&self) -> Result<KeySet, String> {
        let uri = self.discover().await?;
        let response = self
            .http
            .get(&uri)
            .send()
            .await
            .map_err(|e| format!("fetching {uri}: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "fetching {uri}: HTTP {}",
                response.status().as_u16()
            ));
        }
        let set: Value = response
            .json()
            .await
            .map_err(|e| format!("{uri} is not JSON: {e}"))?;
        let keys = set["keys"]
            .as_array()
            .cloned()
            .ok_or_else(|| format!("{uri} has no keys"))?;
        Ok(KeySet {
            keys,
            fetched: Instant::now(),
        })
    }

    /// The published keys a token with `kid` could be signed by, fetching or
    /// refetching the set as its age and the cooldown allow.
    async fn candidates(&self, kid: Option<&str>) -> Result<Vec<DecodingKey>, String> {
        let mut held = self.keys.lock().await;
        if held
            .as_ref()
            .is_none_or(|set| set.fetched.elapsed() >= MAX_AGE)
        {
            *held = Some(self.fetch().await?);
        }
        let mut found = matching(
            held.as_ref().map(|s| s.keys.as_slice()).unwrap_or_default(),
            kid,
        );
        if found.is_empty()
            && held
                .as_ref()
                .is_some_and(|set| set.fetched.elapsed() >= REFETCH_COOLDOWN)
        {
            *held = Some(self.fetch().await?);
            found = matching(
                held.as_ref().map(|s| s.keys.as_slice()).unwrap_or_default(),
                kid,
            );
        }
        if found.is_empty() {
            return Err("no key the issuer publishes matches the token".to_owned());
        }
        Ok(found)
    }

    /// The token's claims, if the trusted issuer signed it (RS256) for this
    /// knowledge base and it is within its times.
    pub async fn verify(&self, token: &str) -> Result<Map<String, Value>, String> {
        let header = decode_header(token).map_err(|e| e.to_string())?;
        if header.alg != Algorithm::RS256 {
            return Err(format!(
                "the issuer signs RS256, and this token says {:?}",
                header.alg
            ));
        }
        let mut validation = Validation::new(Algorithm::RS256);
        validation.leeway = 0;
        validation.validate_nbf = true;
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[&self.audience]);
        validation.required_spec_claims = HashSet::from(["iss".to_owned(), "aud".to_owned()]);
        let mut refusal = "signature verification failed".to_owned();
        for key in self.candidates(header.kid.as_deref()).await? {
            match decode::<Map<String, Value>>(token, &key, &validation) {
                Ok(data) => return Ok(data.claims),
                Err(error) if *error.kind() == ErrorKind::InvalidSignature => {
                    refusal = error.to_string()
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        Err(refusal)
    }
}

/// RSA signing keys, by id when the token names one.
fn matching(keys: &[Value], kid: Option<&str>) -> Vec<DecodingKey> {
    keys.iter()
        .filter(|k| k["kty"] == "RSA")
        .filter(|k| k["alg"].is_null() || k["alg"] == "RS256")
        .filter(|k| k["use"].is_null() || k["use"] == "sig")
        .filter(|k| {
            k["key_ops"]
                .as_array()
                .is_none_or(|ops| ops.iter().any(|op| op == "verify"))
        })
        .filter(|k| kid.is_none_or(|kid| k["kid"] == kid))
        .filter_map(|k| DecodingKey::from_rsa_components(k["n"].as_str()?, k["e"].as_str()?).ok())
        .collect()
}
