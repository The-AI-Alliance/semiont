//! Who a bearer token says its holder is: built from the token's own claims,
//! with no row behind it. The DID is the identity; everything downstream keys
//! on it.

use semiont::identity;
use semiont::roles::{is_agent, roles_of};
use semiont::types::UserId;
use semiont_http_service::IssuerVerifier;
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct Principal {
    /// What `POST /bus/emit` stamps as `_userId`.
    pub did: UserId,
    /// The token's `email`, when it carries one: an agent's account need not.
    pub email: Option<String>,
    pub name: Option<String>,
    /// The issuer's `picture` claim, when it sends one.
    pub image: Option<String>,
    /// The authority this principal is named under: the knowledge base's domain.
    pub domain: String,
    /// The roles the token carries, for `_roles`: a transient authorization fact.
    pub roles: Option<Vec<String>>,
}

/// Whom a refused token is counted against, read without verifying it: the
/// trusted issuer, and the claim the gateway names a holder by,
/// `subject_claim`. None for a token naming another issuer, or no holder.
pub fn holder_of(token: &str, issuer: &str, subject_claim: &str) -> Option<(String, String)> {
    let claims: Value = jsonwebtoken::dangerous::insecure_decode_claims(token).ok()?;
    let iss = claims["iss"].as_str().filter(|iss| *iss == issuer)?;
    let holder = claims[subject_claim].as_str().filter(|h| !h.is_empty())?;
    Some((iss.to_owned(), holder.to_owned()))
}

/// The principal behind a bearer token, which the knowledge base's issuer
/// signed: a person or an agent alike, named by the subject the issuer
/// asserted — the claim `identity.subjectClaim` selects — under the knowledge
/// base's domain, and told apart by the token's kind, which the issuer stamps
/// on every agent's account. No admission check of our own: the issuer decided
/// by minting the token.
pub async fn principal_from_token(
    token: &str,
    issuer: &IssuerVerifier,
    domain: &str,
    subject_claim: &str,
) -> Result<Principal, String> {
    let claims = issuer.verify(token).await?;
    let subject = claims.get(subject_claim).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| {
        format!("Token carries no \"{subject_claim}\" claim — the claim this knowledge base names its principals by (identity.subjectClaim)")
    })?;
    let email = claims
        .get("email")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if email.is_some() && claims.get("email_verified") == Some(&Value::Bool(false)) {
        return Err("Token email is not verified".to_owned());
    }
    let did = if is_agent(&claims) {
        identity::agent_did(domain, subject)
    } else {
        identity::person_did(domain, subject)
    };
    Ok(Principal {
        did: UserId::new(did).map_err(|e| e.to_string())?,
        email,
        name: claims
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_owned),
        image: claims
            .get("picture")
            .and_then(Value::as_str)
            .map(str::to_owned),
        domain: domain.to_owned(),
        roles: roles_of(&claims),
    })
}
