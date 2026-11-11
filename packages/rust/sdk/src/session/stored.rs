//! What a session layer keeps in a `SessionStorage`, and under which keys:
//! each knowledge base's tokens, the list of registered knowledge bases and
//! which of them is active, each one's open resources and last-viewed
//! resource, and what a client keeps of one person: its persisted queries
//! and where its stream was.
//!
//! An entry that does not read as what it should be is not there: a store
//! written by another release is dropped entry by entry, never half-read.

use super::kept::SignInKept;
use super::token_expiry;
use crate::refresh::CacheQuery;
use crate::storage::SessionStorage;
use crate::transport::BoxFuture;
use crate::types::KnowledgeBase;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::digest::{SHA256, digest};
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::sync::Arc;
use std::time::SystemTime;

const SESSION_PREFIX: &str = "semiont.session.";
const LAST_EVENT_ID_PREFIX: &str = "semiont.lastEventId.";
const CACHE_PREFIX: &str = "semiont.cache.";
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

/// The key of the person a did names: the unpadded base64url SHA-256 of its
/// UTF-8. What is kept of a person is kept under this, never under the did.
pub fn person_key(did: &str) -> String {
    URL_SAFE_NO_PAD.encode(digest(&SHA256, did.as_bytes()))
}

/// The key where a knowledge base's stream was is kept under, for the person
/// whose key is `person_key`.
pub fn last_event_id_key(kb_id: &str, person_key: &str) -> String {
    format!("{LAST_EVENT_ID_PREFIX}{kb_id}.{person_key}")
}

/// The key a persisted query of a knowledge base is kept under, for the
/// person whose key is `person_key`.
pub fn cache_key(kb_id: &str, person_key: &str, query: CacheQuery) -> String {
    format!("{CACHE_PREFIX}{kb_id}.{person_key}.{}", query.name())
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
    /// The key (`person_key`) of the person the gateway said this sign-in's
    /// token is; none until it has said. A renewal keeps it, and a new
    /// sign-in names nobody.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub person_key: Option<String>,
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

/// Save a new sign-in of a knowledge base in place of the one stored, and
/// forget that one: what was kept for the person it named is deleted
/// (`forget_kept`), even when the new sign-in turns out to be theirs, as a
/// new sign-in names nobody until its gateway names them
/// (protocol/specs/src/session/persisted-cases.json, `forget`). A client
/// still open on the replaced sign-in writes nothing once the stored one
/// does not name its person (`crossTab`). A renewal is no new sign-in: it
/// writes its tokens over the stored ones with the storage's `update`,
/// keeping the person, and deletes nothing.
pub fn store_session(
    storage: &dyn SessionStorage,
    kb_id: &str,
    session: &StoredSession,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let replaced = replace_stored_session(storage, kb_id, Some(session))?;
    forget_kept(storage, kb_id, replaced.as_ref())
}

/// Forget a knowledge base's saved sign-in, and with it what was kept for
/// the person it named (`forget_kept`). A client of that person that is
/// still open writes nothing once the stored sign-in does not name them
/// (protocol/specs/src/session/persisted-cases.json, `crossTab`), so what
/// it has yet to write, its closing's included, does not put back what is
/// deleted here.
pub fn clear_stored_session(
    storage: &dyn SessionStorage,
    kb_id: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let forgotten = replace_stored_session(storage, kb_id, None)?;
    forget_kept(storage, kb_id, forgotten.as_ref())
}

/// Put a new sign-in in place of a knowledge base's stored one, or nothing,
/// as one step, and give what was there: what was kept for the person it
/// named is left for `forget_kept`, for a caller that deletes it once
/// nothing more can write it.
pub(crate) fn replace_stored_session(
    storage: &dyn SessionStorage,
    kb_id: &str,
    with: Option<&StoredSession>,
) -> Result<Option<StoredSession>, Box<dyn std::error::Error + Send + Sync>> {
    let mut replaced = None;
    storage.update(&session_key(kb_id), &mut |stored| {
        replaced = stored.and_then(StoredSession::read);
        with.map(StoredSession::written)
    })?;
    Ok(replaced)
}

/// The sign-in a registry keeps of a knowledge base in `storage`, under its
/// id: what the registry's sessions are built from, renew through, record
/// their person on and forget. Keeping a new sign-in replaces the stored one
/// and forgets it (`store_session`), and forgetting deletes what was kept
/// for the person it named (`clear_stored_session`).
pub fn kept_in(storage: Arc<dyn SessionStorage>, kb_id: &str) -> Arc<dyn SignInKept> {
    Arc::new(KeptIn {
        storage,
        kb_id: kb_id.to_owned(),
    })
}

/// See `kept_in`.
struct KeptIn {
    storage: Arc<dyn SessionStorage>,
    kb_id: String,
}

impl SignInKept for KeptIn {
    fn held(&self) -> BoxFuture<'_, Result<Option<StoredSession>, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move { Ok(stored_session(self.storage.as_ref(), &self.kb_id)) })
    }

    fn keep(
        &self,
        sign_in: StoredSession,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move { store_session(self.storage.as_ref(), &self.kb_id, &sign_in) })
    }

    fn renewed<'a>(
        &'a self,
        read: &'a StoredSession,
        access: &'a str,
        refresh: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            let mut given = None;
            self.storage
                .update(&session_key(&self.kb_id), &mut |stored| {
                    let Some(kept) = stored.and_then(StoredSession::read) else {
                        given = None;
                        return stored.map(str::to_owned);
                    };
                    // Another context renewed, or signed in again, while the
                    // grant was in flight: its tokens stand. The refresh
                    // token alone does not tell, since an issuer that
                    // rotates none leaves it as it was.
                    if kept.access != read.access || kept.refresh != read.refresh {
                        given = Some(kept.access);
                        return stored.map(str::to_owned);
                    }
                    given = Some(access.to_owned());
                    Some(
                        StoredSession {
                            access: access.to_owned(),
                            refresh: refresh.to_owned(),
                            ..kept
                        }
                        .written(),
                    )
                })?;
            Ok(given)
        })
    }

    fn record_person_key<'a>(
        &'a self,
        access: &'a str,
        person_key: &'a str,
    ) -> BoxFuture<'a, Result<bool, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            let names = |held: &StoredSession| {
                held.access == access
                    && held
                        .person_key
                        .as_deref()
                        .is_none_or(|named| named == person_key)
            };
            // Written only when there is a person to record: a sign-in that
            // names them already, or holds another token, is left unwritten.
            match stored_session(self.storage.as_ref(), &self.kb_id) {
                Some(held) if names(&held) && held.person_key.is_none() => {}
                held => return Ok(held.as_ref().is_some_and(names)),
            }
            let mut named = false;
            self.storage
                .update(&session_key(&self.kb_id), &mut |stored| {
                    let held = stored.and_then(StoredSession::read);
                    named = held.as_ref().is_some_and(names);
                    match held {
                        Some(held) if named => Some(
                            StoredSession {
                                person_key: Some(person_key.to_owned()),
                                ..held
                            }
                            .written(),
                        ),
                        _ => stored.map(str::to_owned),
                    }
                })?;
            Ok(named)
        })
    }

    fn forget(&self) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move { clear_stored_session(self.storage.as_ref(), &self.kb_id) })
    }
}

/// Delete what a client kept on a knowledge base for the person a forgotten
/// sign-in named: every persisted query's answers, and where its stream
/// was. Forgetting a saved sign-in that named them, however it is
/// forgotten, deletes these (protocol/specs/src/session/persisted-cases.json,
/// `forget`); one that named nobody leaves nothing known to be anyone's,
/// and nothing is deleted.
pub(crate) fn forget_kept(
    storage: &dyn SessionStorage,
    kb_id: &str,
    forgotten: Option<&StoredSession>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Some(person_key) = forgotten.and_then(|forgotten| forgotten.person_key.as_deref()) else {
        return Ok(());
    };
    for query in CacheQuery::PERSISTED {
        storage.delete(&cache_key(kb_id, person_key, *query))?;
    }
    storage.delete(&last_event_id_key(kb_id, person_key))
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

pub fn save_knowledge_bases(
    storage: &dyn SessionStorage,
    knowledge_bases: &[KnowledgeBase],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // A list of structs of strings and numbers always serializes.
    let written = serde_json::to_string(knowledge_bases).unwrap_or_default();
    storage.set(KNOWLEDGE_BASES_KEY, &written)
}
