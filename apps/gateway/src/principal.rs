//! Who a bearer token says its holder is: built from the token's own claims,
//! with no row behind it. The DID is the identity; everything downstream keys
//! on it.

use crate::tokens::KeyRing;
use semiont::identity;
use semiont::roles::{SERVICE_ROLE, WORKER_ROLE, has_role, roles_of};
use semiont::types::UserId;
use semiont_http_service::IssuerVerifier;
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct Principal {
    /// What `POST /bus/emit` stamps as `_userId`.
    pub did: UserId,
    pub email: String,
    pub name: Option<String>,
    /// The issuer's `picture` claim, when it sends one.
    pub image: Option<String>,
    /// The authority this principal is named under: the knowledge base's domain.
    pub domain: String,
    /// The roles the token carries, for `_roles`: a transient authorization fact.
    pub roles: Option<Vec<String>>,
}

/// The token's `iss`, unverified: which verifier to ask.
fn issuer_of(token: &str) -> Option<String> {
    let claims: Value = jsonwebtoken::dangerous::insecure_decode_claims(token).ok()?;
    claims["iss"].as_str().map(str::to_owned)
}

/// The principal behind a bearer token: a token from the trusted issuer is
/// verified against its keys; any other is one this gateway signed.
pub async fn principal_from_token(
    token: &str,
    issuer: &IssuerVerifier,
    keys: &KeyRing,
    subject_claim: &str,
) -> Result<Principal, String> {
    if issuer_of(token).as_deref() == Some(issuer.issuer()) {
        return person(token, issuer, keys.domain(), subject_claim).await;
    }
    let claims = keys
        .verify_agent(token)
        .map_err(|refusal| refusal.to_string())?;
    Ok(Principal {
        did: claims.did,
        email: claims.email,
        name: claims.name,
        image: None,
        domain: claims.domain,
        roles: claims.roles,
    })
}

/// A person the issuer vouched for, named by the claim `identity.subjectClaim`
/// selects under the knowledge base's domain. No admission check of our own:
/// the issuer decided by minting the token.
async fn person(
    token: &str,
    issuer: &IssuerVerifier,
    domain: &str,
    subject_claim: &str,
) -> Result<Principal, String> {
    let claims = issuer.verify(token).await?;
    let subject = claims.get(subject_claim).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| {
        format!("Token carries no \"{subject_claim}\" claim — the claim this knowledge base names its people by ([identity] subjectClaim)")
    })?;
    let email = claims
        .get("email")
        .and_then(Value::as_str)
        .ok_or("Token carries no email claim")?;
    if claims.get("email_verified") == Some(&Value::Bool(false)) {
        return Err("Token email is not verified".to_owned());
    }
    Ok(Principal {
        did: UserId::new(identity::person_did(domain, subject)).map_err(|e| e.to_string())?,
        email: email.to_owned(),
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

/// Who may ask for an agent token: a service account the issuer vouched for.
pub struct AuthorizedMinter {
    /// `azp` when the issuer sends one, else the subject; for the log.
    pub client: String,
    /// Whether it carries the worker role, which the agent token then carries too.
    pub worker_capable: bool,
}

/// A refusal: `message` is what the caller is told, `reason` what the log records.
pub struct MinterRefused {
    pub message: String,
    pub reason: String,
}

pub async fn authorize_minter(
    token: &str,
    issuer: &IssuerVerifier,
) -> Result<AuthorizedMinter, MinterRefused> {
    let claims = issuer.verify(token).await.map_err(|reason| MinterRefused {
        message: "Invalid token".to_owned(),
        reason,
    })?;
    if !has_role(&claims, SERVICE_ROLE) {
        let missing = format!("The token carries no '{SERVICE_ROLE}' role in its 'roles' claim");
        return Err(MinterRefused {
            message: missing.clone(),
            reason: missing,
        });
    }
    let client = claims
        .get("azp")
        .and_then(Value::as_str)
        .or_else(|| claims.get("sub").and_then(Value::as_str))
        .unwrap_or("unknown")
        .to_owned();
    Ok(AuthorizedMinter {
        client,
        worker_capable: has_role(&claims, WORKER_ROLE),
    })
}
