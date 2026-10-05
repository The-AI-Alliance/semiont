//! Verifies tokens from the one issuer the knowledge base trusts, against the
//! keys it publishes. Discovery is read once. The key set is fetched when none
//! is held, when the one held has reached its maximum age, and for a key id it
//! lacks once it is a cooldown old. One fetch runs at a time, under a
//! deadline: the requests that need it wait for it, and its failure stands
//! for a cooldown. The three timings are the service's to state.

use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const NO_MATCHING_KEY: &str = "no key the issuer publishes matches the token";

/// When a verifier fetches the issuer's keys.
#[derive(Clone, Copy, Debug)]
pub struct KeyTimings {
    /// How long a fetched key set is used.
    pub max_age: Duration,
    /// The least time between two fetches, and how long a failed one stands.
    pub refetch_cooldown: Duration,
    /// How long a fetch may take.
    pub fetch_deadline: Duration,
}

pub struct IssuerVerifier {
    issuer: String,
    audience: String,
    timings: KeyTimings,
    http: reqwest::Client,
    jwks_uri: Mutex<Option<String>>,
    held: Mutex<Held>,
    /// Held by the one fetch in flight; a request that needs a fetch waits here.
    fetching: tokio::sync::Mutex<()>,
}

struct KeySet {
    keys: Vec<Value>,
    fetched: Instant,
}

#[derive(Default)]
struct Held {
    set: Option<KeySet>,
    /// The last fetch, if it failed: when, and why.
    failed: Option<(Instant, String)>,
}

/// What the held keys say of a token's key id.
enum Answer {
    Keys(Vec<DecodingKey>),
    Refused(String),
    /// Neither: a fetch is due.
    Fetch,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

impl IssuerVerifier {
    pub fn new(
        issuer: String,
        audience: String,
        timings: KeyTimings,
        http: reqwest::Client,
    ) -> IssuerVerifier {
        IssuerVerifier {
            issuer,
            audience,
            timings,
            http,
            jwks_uri: Mutex::new(None),
            held: Mutex::new(Held::default()),
            fetching: tokio::sync::Mutex::new(()),
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
        if let Some(uri) = locked(&self.jwks_uri).clone() {
            return Ok(uri);
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
        *locked(&self.jwks_uri) = Some(jwks_uri.to_owned());
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

    /// What the keys held now answer for `kid`, without fetching.
    fn answer(&self, kid: Option<&str>) -> Answer {
        let cooldown = self.timings.refetch_cooldown;
        let max_age = self.timings.max_age;
        let held = locked(&self.held);
        let usable = held
            .set
            .as_ref()
            .filter(|set| set.fetched.elapsed() < max_age);
        if let Some(set) = usable {
            let found = matching(&set.keys, kid);
            if !found.is_empty() {
                return Answer::Keys(found);
            }
        }
        match &held.failed {
            Some((at, why)) if at.elapsed() < cooldown => Answer::Refused(match usable {
                Some(_) => NO_MATCHING_KEY.to_owned(),
                None => why.clone(),
            }),
            _ if usable.is_none_or(|set| set.fetched.elapsed() >= cooldown) => Answer::Fetch,
            _ => Answer::Refused(NO_MATCHING_KEY.to_owned()),
        }
    }

    /// The published keys a token with `kid` could be signed by, fetching the
    /// set when that is due. A request that needs a fetch waits for the one in
    /// flight and takes its outcome, so however many arrive, one is made.
    async fn candidates(&self, kid: Option<&str>) -> Result<Vec<DecodingKey>, String> {
        loop {
            match self.answer(kid) {
                Answer::Keys(found) => return Ok(found),
                Answer::Refused(why) => return Err(why),
                Answer::Fetch => {}
            }
            let _one = self.fetching.lock().await;
            if !matches!(self.answer(kid), Answer::Fetch) {
                continue;
            }
            let deadline = self.timings.fetch_deadline;
            let fetched = tokio::time::timeout(deadline, self.fetch())
                .await
                .unwrap_or_else(|_| {
                    Err(format!(
                        "fetching the keys of {} took longer than {} s",
                        self.issuer,
                        deadline.as_secs()
                    ))
                });
            let mut held = locked(&self.held);
            match fetched {
                Ok(set) => {
                    held.set = Some(set);
                    held.failed = None;
                }
                Err(why) => held.failed = Some((Instant::now(), why)),
            }
        }
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
