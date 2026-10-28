//! The tokens the gateway signs itself — agent tokens and media tokens — with
//! the key ring in JWT_SECRET: comma-separated keys, whitespace around each
//! ignored, every one at least 32 characters. The first key signs; a token
//! signed by any key verifies, so the signing key can change without
//! invalidating what is outstanding (`JWT_SECRET=<new>,<old>`).

use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use semiont::types::UserId;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

/// How long an agent token lives: the one credential here with no revocation
/// behind it, so its lifetime is its revocation window.
const AGENT_TOKEN_SECONDS: u64 = 60 * 60;
/// How long a media token lives.
const MEDIA_TOKEN_SECONDS: u64 = 5 * 60;

pub struct KeyRing {
    keys: Vec<String>,
    /// The knowledge base's domain: the issuer of the agent tokens it signs.
    domain: String,
}

/// JWT_SECRET, as a ring, or why it cannot be one. The message never carries a key.
pub fn require_jwt_secret() -> Result<Vec<String>, String> {
    let raw = std::env::var("JWT_SECRET").ok().filter(|v| !v.is_empty()).ok_or_else(|| {
        "JWT_SECRET is not set. `semiont start` generates one per knowledge base and injects it; set JWT_SECRET explicitly to override."
            .to_owned()
    })?;
    let ring: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_owned)
        .collect();
    if ring.is_empty() {
        return Err("JWT_SECRET is empty".to_owned());
    }
    if ring.iter().any(|key| key.chars().count() < 32) {
        return Err("JWT_SECRET must be at least 32 characters long (each value, if a comma-separated ring)".to_owned());
    }
    Ok(ring)
}

/// Why a token was refused, for the log; the caller is told only that it was.
#[derive(Debug)]
pub enum Refusal {
    Expired,
    NotYetValid,
    Invalid(String),
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::Expired => write!(f, "Token has expired"),
            Refusal::NotYetValid => write!(f, "Token not active yet"),
            Refusal::Invalid(why) => write!(f, "{why}"),
        }
    }
}

/// What an agent token says, once verified.
#[derive(Debug, Clone)]
pub struct AgentClaims {
    pub did: UserId,
    pub email: String,
    pub name: Option<String>,
    pub domain: String,
    pub roles: Option<Vec<String>>,
}

#[derive(Serialize)]
struct AgentToken<'a> {
    did: &'a str,
    email: &'a str,
    name: &'a str,
    domain: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    roles: Option<&'a [String]>,
    iat: u64,
    exp: u64,
    iss: &'a str,
}

#[derive(Serialize)]
struct MediaToken<'a> {
    purpose: &'static str,
    sub: &'a str,
    iat: u64,
    exp: u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl KeyRing {
    pub fn new(keys: Vec<String>, domain: String) -> KeyRing {
        KeyRing { keys, domain }
    }

    pub fn domain(&self) -> &str {
        &self.domain
    }

    fn sign(&self, claims: &impl Serialize) -> String {
        encode(
            &Header::new(Algorithm::HS256),
            claims,
            &EncodingKey::from_secret(self.keys[0].as_bytes()),
        )
        .unwrap_or_else(|e| panic!("signing a token: {e}"))
    }

    /// A software agent's token, issued by the knowledge base for an hour.
    pub fn agent_token(
        &self,
        did: &str,
        email: &str,
        name: &str,
        roles: Option<&[String]>,
    ) -> String {
        let iat = now();
        self.sign(&AgentToken {
            did,
            email,
            name,
            domain: &self.domain,
            roles,
            iat,
            exp: iat + AGENT_TOKEN_SECONDS,
            iss: &self.domain,
        })
    }

    /// A token naming one resource, for five minutes, and nothing else.
    pub fn media_token(&self, resource_id: &str) -> String {
        let iat = now();
        self.sign(&MediaToken {
            purpose: "media",
            sub: resource_id,
            iat,
            exp: iat + MEDIA_TOKEN_SECONDS,
        })
    }

    /// The claims of a token any key of the ring signed. Expiry and
    /// not-yet-valid belong to the token, not to the key, so they end the walk.
    fn verify_across(&self, token: &str) -> Result<Value, Refusal> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 0;
        validation.validate_nbf = true;
        validation.validate_aud = false;
        validation.required_spec_claims = HashSet::new();
        for key in &self.keys {
            match decode::<Value>(
                token,
                &DecodingKey::from_secret(key.as_bytes()),
                &validation,
            ) {
                Ok(data) => return Ok(data.claims),
                Err(error) => match error.kind() {
                    ErrorKind::InvalidSignature => continue,
                    ErrorKind::ExpiredSignature => return Err(Refusal::Expired),
                    ErrorKind::ImmatureSignature => return Err(Refusal::NotYetValid),
                    _ => return Err(Refusal::Invalid("Invalid token signature".to_owned())),
                },
            }
        }
        Err(Refusal::Invalid("Invalid token signature".to_owned()))
    }

    /// An agent token this gateway signed: its signature, then its claims.
    pub fn verify_agent(&self, token: &str) -> Result<AgentClaims, Refusal> {
        let claims = self.verify_across(token)?;
        agent_claims(&claims).ok_or_else(|| Refusal::Invalid("Invalid token payload".to_owned()))
    }

    /// A media token for `resource_id`.
    pub fn verify_media(&self, token: &str, resource_id: &str) -> Result<(), String> {
        let claims = match self.verify_across(token) {
            Ok(claims) => claims,
            Err(Refusal::Expired) => return Err("Media token expired".to_owned()),
            Err(_) => return Err("Invalid media token".to_owned()),
        };
        if claims["purpose"] != "media" {
            return Err("Invalid media token".to_owned());
        }
        if claims["sub"] != resource_id {
            return Err("Media token resource mismatch".to_owned());
        }
        Ok(())
    }
}

/// An agent token's claims: a DID, an address, the domain, and optionally a
/// name, roles and the times.
fn agent_claims(claims: &Value) -> Option<AgentClaims> {
    let did = UserId::new(claims["did"].as_str()?).ok()?;
    let email = claims["email"].as_str().filter(|e| is_address(e))?;
    let domain = claims["domain"].as_str()?;
    let name = match &claims["name"] {
        Value::Null => None,
        Value::String(name) => Some(name.clone()),
        _ => return None,
    };
    let roles = match &claims["roles"] {
        Value::Null => None,
        Value::Array(items) => Some(
            items
                .iter()
                .map(|r| r.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?,
        ),
        _ => return None,
    };
    for time in ["iat", "exp"] {
        if !(claims[time].is_null() || claims[time].is_number()) {
            return None;
        }
    }
    Some(AgentClaims {
        did,
        email: email.to_owned(),
        name,
        domain: domain.to_owned(),
        roles,
    })
}

/// `local@domain.tld`: one `@`, no whitespace, a dot in the domain.
fn is_address(address: &str) -> bool {
    let Some((local, domain)) = address.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.contains('@')
        && !address.chars().any(char::is_whitespace)
}
