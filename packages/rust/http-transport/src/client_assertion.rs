//! A service account's assertion of itself, signed with its own key: OpenID
//! Connect's `private_key_jwt`, the client assertion of RFC 7523 §2.2.
//!
//! The issuer holds the key's public half, registered on the account's
//! client, and checks the signature with it: the private key never leaves
//! the process, and no secret is sent. The assertion's shape is
//! specs/src/session/client-assertion-cases.json's.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::digest::{SHA256, digest};
use ring::rand::SystemRandom;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair, RsaPublicKeyComponents};
use serde_json::{Value, json};

/// The grant's `client_assertion_type` for an assertion that is a JWT.
pub const JWT_BEARER: &str = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/// How long after it is made an assertion is good for, in seconds.
pub const LIFETIME_SECONDS: u64 = 60;

/// The JWK thumbprint (RFC 7638) of the RSA key whose modulus is `n` and
/// whose exponent is `e`, each big-endian with no leading zero byte: the
/// SHA-256 of its members `e`, `kty` and `n`, in that order, with no
/// whitespace.
pub fn thumbprint(n: &[u8], e: &[u8]) -> String {
    let members = format!(
        r#"{{"e":"{}","kty":"RSA","n":"{}"}}"#,
        URL_SAFE_NO_PAD.encode(e),
        URL_SAFE_NO_PAD.encode(n)
    );
    URL_SAFE_NO_PAD.encode(digest(&SHA256, members.as_bytes()))
}

/// An assertion's header: RS256, and the key it is signed with, by the
/// thumbprint of its modulus `n` and its exponent `e`.
pub fn header(n: &[u8], e: &[u8]) -> Value {
    json!({ "alg": "RS256", "kid": thumbprint(n, e) })
}

/// An assertion's claims: the client is its issuer and its subject, and the
/// token endpoint its audience.
pub fn claims(client_id: &str, token_endpoint: &str, issued_at: u64, jti: &str) -> Value {
    json!({
        "iss": client_id,
        "sub": client_id,
        "aud": token_endpoint,
        "jti": jti,
        "iat": issued_at,
        "exp": issued_at + LIFETIME_SECONDS,
    })
}

/// The assertion, signed: a compact JWT of `header` and `claims`, RS256 with
/// `key`.
pub fn client_assertion(
    key: &RsaKeyPair,
    client_id: &str,
    token_endpoint: &str,
    issued_at: u64,
    jti: &str,
) -> Result<String, ring::error::Unspecified> {
    let public = RsaPublicKeyComponents::<Vec<u8>>::from(key.public());
    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header(&public.n, &public.e).to_string()),
        URL_SAFE_NO_PAD.encode(claims(client_id, token_endpoint, issued_at, jti).to_string())
    );
    let mut signature = vec![0; key.public().modulus_len()];
    key.sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        signing_input.as_bytes(),
        &mut signature,
    )?;
    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    ))
}
