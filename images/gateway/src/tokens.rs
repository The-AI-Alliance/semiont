//! The token the gateway signs itself — a media token — with the key ring in
//! JWT_SECRET: comma-separated keys, whitespace around each
//! ignored, every one at least 32 characters. The first key signs; a token
//! signed by any key verifies, so the signing key can change without
//! invalidating what is outstanding (`JWT_SECRET=<new>,<old>`). A media token
//! names the knowledge base whose gateway minted it, and no other's gateway
//! accepts it, so two knowledge bases sharing a ring share no access.

use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

/// How long a media token lives.
const MEDIA_TOKEN_SECONDS: u64 = 5 * 60;

pub struct KeyRing {
    keys: Vec<String>,
    /// The domain of the knowledge base the gateway serves: the `iss` of every
    /// media token it mints, and of every one it accepts.
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

/// Why a token was refused.
#[derive(Debug, PartialEq)]
enum Refusal {
    Expired,
    Invalid,
}

#[derive(Serialize)]
struct MediaToken<'a> {
    purpose: &'static str,
    iss: &'a str,
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

    fn sign(&self, claims: &impl Serialize) -> String {
        encode(
            &Header::new(Algorithm::HS256),
            claims,
            &EncodingKey::from_secret(self.keys[0].as_bytes()),
        )
        .unwrap_or_else(|e| panic!("signing a token: {e}"))
    }

    /// A token naming one resource of this knowledge base, for five minutes,
    /// and nothing else.
    pub fn media_token(&self, resource_id: &str) -> String {
        let iat = now();
        self.sign(&MediaToken {
            purpose: "media",
            iss: &self.domain,
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
                    _ => return Err(Refusal::Invalid),
                },
            }
        }
        Err(Refusal::Invalid)
    }

    /// A media token this knowledge base's gateway minted for `resource_id`.
    pub fn verify_media(&self, token: &str, resource_id: &str) -> Result<(), String> {
        let claims = match self.verify_across(token) {
            Ok(claims) => claims,
            Err(Refusal::Expired) => return Err("Media token expired".to_owned()),
            Err(_) => return Err("Invalid media token".to_owned()),
        };
        if claims["purpose"] != "media" {
            return Err("Invalid media token".to_owned());
        }
        if claims["iss"] != self.domain {
            return Err("Media token of another knowledge base".to_owned());
        }
        if claims["sub"] != resource_id {
            return Err("Media token resource mismatch".to_owned());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "0123456789abcdef0123456789abcdef";
    const NEW: &str = "fedcba9876543210fedcba9876543210";
    const DOMAIN: &str = "example.org:kb";

    /// A ring of `keys` for the knowledge base at `domain`.
    fn ring(keys: &[&str], domain: &str) -> KeyRing {
        KeyRing::new(
            keys.iter().map(|key| (*key).to_owned()).collect(),
            domain.to_owned(),
        )
    }

    #[test]
    fn a_media_token_opens_the_resource_it_names_and_no_other() {
        let keys = ring(&[NEW], DOMAIN);
        let token = keys.media_token("r1");
        assert_eq!(keys.verify_media(&token, "r1"), Ok(()));
        assert!(keys.verify_media(&token, "r2").is_err());
    }

    #[test]
    fn a_media_token_signed_by_a_key_still_on_the_ring_verifies() {
        let token = ring(&[OLD], DOMAIN).media_token("r1");
        let rotated = ring(&[NEW, OLD], DOMAIN);
        assert_eq!(rotated.verify_media(&token, "r1"), Ok(()));
        assert!(ring(&[NEW], DOMAIN).verify_media(&token, "r1").is_err());
    }

    #[test]
    fn a_media_token_opens_nothing_of_another_knowledge_base_on_the_same_ring() {
        let token = ring(&[NEW], DOMAIN).media_token("r1");
        assert_eq!(
            ring(&[NEW], "example.org:another-kb").verify_media(&token, "r1"),
            Err("Media token of another knowledge base".to_owned())
        );
    }

    #[test]
    fn a_media_token_naming_no_knowledge_base_is_refused() {
        let keys = ring(&[NEW], DOMAIN);
        let iat = now();
        let token = keys.sign(&serde_json::json!({
            "purpose": "media",
            "sub": "r1",
            "iat": iat,
            "exp": iat + MEDIA_TOKEN_SECONDS,
        }));
        assert_eq!(
            keys.verify_media(&token, "r1"),
            Err("Media token of another knowledge base".to_owned())
        );
    }
}
