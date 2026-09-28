//! The realm's roles, in the flat `roles` claim. The same strings the
//! launcher writes into the realm and @semiont/core checks;
//! `npm run lint:service-role` holds every site to one value.

use serde_json::{Map, Value};

pub const ROLES_CLAIM: &str = "roles";
/// Carried by every service account: lets it exchange its token for an agent token.
pub const SERVICE_ROLE: &str = "semiont-service";
/// Carried by a worker: the agent token it receives may claim jobs.
pub const WORKER_ROLE: &str = "semiont-worker";

pub fn has_role(claims: &Map<String, Value>, role: &str) -> bool {
    claims
        .get(ROLES_CLAIM)
        .and_then(Value::as_array)
        .is_some_and(|roles| roles.iter().any(|r| r.as_str() == Some(role)))
}
