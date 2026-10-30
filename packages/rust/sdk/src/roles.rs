//! What the realm stamps on an account's token: its roles, in the flat
//! `roles` claim, and its kind. The same strings the launcher writes into the
//! realm; `npm run lint:service-role` holds every site to one value.

use serde_json::{Map, Value};

pub const ROLES_CLAIM: &str = "roles";
/// Carried by every service's account: admits it to the services' own routes.
pub const SERVICE_ROLE: &str = "semiont-service";
/// Carried by a worker: it may claim jobs.
pub const WORKER_ROLE: &str = "semiont-worker";

/// The claim that marks an agent's account, and what it holds there: every
/// service's account and every worker's carries it, and a person's never
/// does. A kind, not a role: roles are capabilities, granted to people and
/// agents alike.
pub const KIND_CLAIM: &str = "kind";
pub const AGENT_KIND: &str = "agent";

/// Whether the token's account is an agent's.
pub fn is_agent(claims: &Map<String, Value>) -> bool {
    claims.get(KIND_CLAIM).and_then(Value::as_str) == Some(AGENT_KIND)
}

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
