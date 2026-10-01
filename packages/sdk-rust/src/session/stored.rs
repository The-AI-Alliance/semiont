//! What a session layer keeps in a `SessionStorage`, and under which keys:
//! each knowledge base's tokens, the list of registered knowledge bases and
//! which of them is active, and each one's open resources and last-viewed
//! resource.
//!
//! An entry that does not read as what it should be is not there: a store
//! written by another release is dropped entry by entry, never half-read.

use super::knowledge_base::KnowledgeBase;
use super::token_expiry;
use crate::storage::SessionStorage;
use serde::{Deserialize, Serialize};
use std::time::SystemTime;

const SESSION_PREFIX: &str = "semiont.session.";
/// The registered knowledge bases.
pub const KNOWLEDGE_BASES_KEY: &str = "semiont.knowledgeBases";
/// The id of the active one.
pub const ACTIVE_KEY: &str = "semiont.activeKnowledgeBaseId";
/// Each knowledge base's open resources, by its id.
pub const OPEN_RESOURCES_BY_KB_KEY: &str = "semiont.openResourcesByKb";
/// Each knowledge base's last-viewed resource, by its id.
pub const LAST_VIEWED_RESOURCE_BY_KB_KEY: &str = "semiont.lastViewedResourceByKb";

/// The key a knowledge base's session is stored under.
pub fn session_key(kb_id: &str) -> String {
    format!("{SESSION_PREFIX}{kb_id}")
}

/// The knowledge base a key is the session of, when it is a session's key.
pub fn kb_of_session_key(key: &str) -> Option<&str> {
    key.strip_prefix(SESSION_PREFIX)
}

/// What is kept of a sign-in: the tokens an issuer issued, the client they
/// were issued to, and the issuer's endpoints a renewal and a sign-out need,
/// learned once at sign-in so no session asks again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub access: String,
    pub refresh: String,
    pub client_id: String,
    pub token_endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revocation_endpoint: Option<String>,
}

impl StoredSession {
    /// A stored value as a session; one that is not a session is none.
    pub fn read(stored: &str) -> Option<StoredSession> {
        serde_json::from_str(stored).ok()
    }

    pub fn written(&self) -> String {
        // A struct of strings always serializes.
        serde_json::to_string(self).unwrap_or_default()
    }
}

pub fn stored_session(storage: &dyn SessionStorage, kb_id: &str) -> Option<StoredSession> {
    StoredSession::read(&storage.get(&session_key(kb_id))?)
}

pub fn store_session(storage: &dyn SessionStorage, kb_id: &str, session: &StoredSession) {
    storage.set(&session_key(kb_id), &session.written());
}

pub fn clear_stored_session(storage: &dyn SessionStorage, kb_id: &str) {
    storage.delete(&session_key(kb_id));
}

/// Whether a token is past its expiry at `now`. One that names no expiry is
/// read as expired: nothing says it is still good.
pub fn is_token_expired(token: &str, now: SystemTime) -> bool {
    token_expiry(token).is_none_or(|expiry| expiry < now)
}

/// The registered knowledge bases. Each entry is read on its own, and one
/// that is not a knowledge base with a did is dropped: whoever it was is
/// registered again.
pub fn load_knowledge_bases(storage: &dyn SessionStorage) -> Vec<KnowledgeBase> {
    let Some(stored) = storage.get(KNOWLEDGE_BASES_KEY) else {
        return Vec::new();
    };
    let Ok(entries) = serde_json::from_str::<Vec<serde_json::Value>>(&stored) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value(entry).ok())
        .collect()
}

pub fn save_knowledge_bases(storage: &dyn SessionStorage, knowledge_bases: &[KnowledgeBase]) {
    // A list of structs of strings and numbers always serializes.
    let written = serde_json::to_string(knowledge_bases).unwrap_or_default();
    storage.set(KNOWLEDGE_BASES_KEY, &written);
}
