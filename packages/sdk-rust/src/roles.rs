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
    roles_of(claims).is_some_and(|roles| roles.iter().any(|r| r == role))
}

/// The roles a token carries: the strings in its flat `roles` claim, or none.
pub fn roles_of(claims: &Map<String, Value>) -> Option<Vec<String>> {
    let roles: Vec<String> = claims
        .get(ROLES_CLAIM)?
        .as_array()?
        .iter()
        .filter_map(|r| r.as_str().map(str::to_owned))
        .collect();
    (!roles.is_empty()).then_some(roles)
}
