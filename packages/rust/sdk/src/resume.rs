//! A stream's place in each scope, kept so the next client for the same
//! knowledge base resumes from it: what that client kept of a scope is then
//! brought up to date by the events recorded since, replayed.
//!
//! **The place may lag the caches and never leads them.** A place kept
//! ahead of a cache would have the next client resume past an event the
//! cache it rehydrates never took in. So a place is not written when it is
//! reached. It is remembered, and written with the next write of a cache,
//! and only when the gate says the caches are at rest: no kept cache is
//! still fetching or owes a save, and no refetch an event asked for is still
//! owed, so every one has taken in the event the place names. A place that
//! is not written is only late, which costs a replay.
//!
//! What is kept is protocol/specs/src/session/stored.json's `lastEventIds`:
//! a JSON object from a scope, a resource's id, to the id of the last
//! recorded event delivered on it, a `PersistedEventId`. A pair that is not
//! one is skipped, when it is reached and when it is read; what is kept
//! that is no object is no places.
//!
//! **Closing takes the places once.** As a client closes, before it
//! disposes of anything, it reads whether a fetch is in flight or a refetch
//! is owed, and the places noted until then become the only ones its
//! closing flush may write: all of them when nothing is, none when
//! something is, since closing drops it. A place noted after that is of an
//! event whose refetch closing drops, and is not kept.

use crate::locked;
use crate::required::{fault_of, schema};
use crate::storage::{SessionStorage, StorageChange, StorageSubscription};
use crate::types::ResourceId;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

type Gate = Box<dyn Fn() -> bool + Send + Sync>;

/// Whether `id` is a recorded event's id, a `PersistedEventId`: the only kind
/// that is a place, and the one decider of it, by the spec's pattern.
pub fn is_persisted_event_id(id: &str) -> bool {
    fault_of(schema("PersistedEventId"), &Value::String(id.to_owned())).is_none()
}

/// The places reached and not yet written.
enum Places {
    /// Each place reached is noted, and written when the gate allows.
    Noting(HashMap<ResourceId, String>),
    /// Closing has begun: what its flush may write, and no more are noted.
    Closing(HashMap<ResourceId, String>),
}

struct Coupling {
    storage: Arc<dyn SessionStorage>,
    key: String,
    places: Mutex<Places>,
    gate: Mutex<Option<Gate>>,
}

impl Coupling {
    fn stored(stored: Option<&str>) -> HashMap<ResourceId, String> {
        let Some(Value::Object(places)) =
            stored.and_then(|stored| serde_json::from_str(stored).ok())
        else {
            return HashMap::new();
        };
        places
            .into_iter()
            .filter_map(|(scope, id)| match id {
                Value::String(id) if is_persisted_event_id(&id) => Some((scope.parse().ok()?, id)),
                _ => None,
            })
            .collect()
    }

    /// Write what is remembered, when the gate allows it; once closing has
    /// begun, what closing took.
    fn flush(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let reached = match &mut *locked(&self.places) {
            Places::Noting(pending) => {
                if !locked(&self.gate).as_ref().is_none_or(|gate| gate()) {
                    return Ok(());
                }
                std::mem::take(pending)
            }
            Places::Closing(taken) => std::mem::take(taken),
        };
        if reached.is_empty() {
            return Ok(());
        }
        self.storage.update(&self.key, &mut |stored| {
            let mut places = Coupling::stored(stored);
            places.extend(reached.clone());
            // A map of strings always serializes.
            serde_json::to_string(&places).ok()
        })
    }
}

/// See the module's documentation.
#[derive(Clone)]
pub struct CoupledBookmarks {
    coupling: Arc<Coupling>,
}

impl CoupledBookmarks {
    /// Places kept in `storage` under `key`.
    pub fn new(storage: Arc<dyn SessionStorage>, key: &str) -> CoupledBookmarks {
        CoupledBookmarks {
            coupling: Arc::new(Coupling {
                storage,
                key: key.to_owned(),
                places: Mutex::new(Places::Noting(HashMap::new())),
                gate: Mutex::new(None),
            }),
        }
    }

    /// The places kept, by scope.
    pub fn load(&self) -> HashMap<ResourceId, String> {
        Coupling::stored(self.coupling.storage.get(&self.coupling.key).as_deref())
    }

    /// A place was reached in `scope`. Remembered, and written with a later
    /// write of a cache. An id that is no recorded event's is no place, and
    /// once closing has begun no place is noted.
    pub fn save(&self, scope: &ResourceId, event_id: &str) {
        if !is_persisted_event_id(event_id) {
            return;
        }
        if let Places::Noting(pending) = &mut *locked(&self.coupling.places) {
            pending.insert(scope.clone(), event_id.to_owned());
        }
    }

    /// Closing has begun: `settled`, read now and once, says that no fetch
    /// is in flight and no refetch is owed. The places noted so far are then
    /// the ones the closing flush may write, or none when it is not settled.
    /// Closing twice is closing once.
    pub(crate) fn close(&self, settled: impl FnOnce() -> bool) {
        let mut places = locked(&self.coupling.places);
        if let Places::Noting(pending) = &mut *places {
            let taken = if settled() {
                std::mem::take(pending)
            } else {
                HashMap::new()
            };
            *places = Places::Closing(taken);
        }
    }

    /// Say when the caches are at rest: no kept cache is fetching or owes a
    /// save, and no refetch an event asked for is owed. With no gate every
    /// write of a cache carries what is remembered.
    pub fn set_flush_gate(&self, at_rest: impl Fn() -> bool + Send + Sync + 'static) {
        *locked(&self.coupling.gate) = Some(Box::new(at_rest));
    }

    /// The storage to give the caches: what they write goes to the storage
    /// beneath, and carries the places with it.
    pub(crate) fn storage(&self) -> Arc<dyn SessionStorage> {
        Arc::new(Carrying(self.coupling.clone()))
    }
}

struct Carrying(Arc<Coupling>);

impl SessionStorage for Carrying {
    fn get(&self, key: &str) -> Option<String> {
        self.0.storage.get(key)
    }

    /// A write that failed carries no place.
    fn set(&self, key: &str, value: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.0.storage.set(key, value)?;
        self.0.flush()
    }

    fn delete(&self, key: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.0.storage.delete(key)
    }

    fn update(
        &self,
        key: &str,
        change: &mut dyn FnMut(Option<&str>) -> Option<String>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.0.storage.update(key, change)?;
        self.0.flush()
    }

    fn subscribe(&self, on_change: StorageChange) -> Option<StorageSubscription> {
        self.0.storage.subscribe(on_change)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::InMemorySessionStorage;
    use std::sync::atomic::{AtomicBool, Ordering};

    const KEY: &str = "semiont.lastEventId.kb-a";

    fn places(pairs: &[(&str, &str)]) -> HashMap<ResourceId, String> {
        pairs
            .iter()
            .map(|(scope, id)| (scope.parse().unwrap(), (*id).to_owned()))
            .collect()
    }

    #[test]
    fn a_place_is_written_with_the_next_write_of_a_cache_and_not_before() {
        let storage = Arc::new(InMemorySessionStorage::new());
        let bookmarks = CoupledBookmarks::new(storage.clone(), KEY);
        let caches = bookmarks.storage();
        assert!(bookmarks.load().is_empty());

        bookmarks.save(&"res-1".parse().unwrap(), "p-res-1-7");
        bookmarks.save(&"res-1".parse().unwrap(), "p-res-1-8");
        bookmarks.save(&"res-2".parse().unwrap(), "p-res-2-3");
        assert_eq!(storage.get(KEY), None);

        caches
            .set("semiont.cache.kb-a.resource", "{}")
            .expect("written");
        assert_eq!(
            storage.get("semiont.cache.kb-a.resource").as_deref(),
            Some("{}")
        );
        assert_eq!(
            bookmarks.load(),
            places(&[("res-1", "p-res-1-8"), ("res-2", "p-res-2-3")])
        );

        // A later place of one scope leaves the other's as it was.
        bookmarks.save(&"res-2".parse().unwrap(), "p-res-2-4");
        caches
            .update("semiont.cache.kb-a.resource", &mut |_| {
                Some("{}".to_owned())
            })
            .expect("written");
        assert_eq!(
            bookmarks.load(),
            places(&[("res-1", "p-res-1-8"), ("res-2", "p-res-2-4")])
        );
    }

    #[test]
    fn a_place_waits_for_the_caches_to_be_at_rest() {
        let storage = Arc::new(InMemorySessionStorage::new());
        let bookmarks = CoupledBookmarks::new(storage.clone(), KEY);
        let caches = bookmarks.storage();
        let at_rest = Arc::new(AtomicBool::new(false));
        let gate = at_rest.clone();
        bookmarks.set_flush_gate(move || gate.load(Ordering::SeqCst));

        bookmarks.save(&"res-1".parse().unwrap(), "p-res-1-7");
        caches
            .set("semiont.cache.kb-a.resource", "{}")
            .expect("written");
        // Late, which is safe: the cache that was written may not be the one
        // still taking the event in.
        assert_eq!(storage.get(KEY), None);

        at_rest.store(true, Ordering::SeqCst);
        caches
            .set("semiont.cache.kb-a.annotations", "{}")
            .expect("written");
        assert_eq!(bookmarks.load(), places(&[("res-1", "p-res-1-7")]));
    }

    #[test]
    fn a_pair_that_is_not_a_scope_and_a_recorded_events_id_is_skipped_and_what_is_no_object_is_no_places()
     {
        let storage = Arc::new(InMemorySessionStorage::new());
        for kept in ["not json", r#"["res-1", "p-res-1-1"]"#] {
            storage.set(KEY, kept).expect("written");
            assert!(
                CoupledBookmarks::new(storage.clone(), KEY)
                    .load()
                    .is_empty(),
                "{kept}"
            );
        }
        storage
            .set(
                KEY,
                r#"{"res-1": 7, "res-2": "e-res-2-3", "not an id!": "p-x-1", "res-3": "p-res-3-4"}"#,
            )
            .expect("written");
        let bookmarks = CoupledBookmarks::new(storage.clone(), KEY);
        assert_eq!(bookmarks.load(), places(&[("res-3", "p-res-3-4")]));

        // The next places written keep what was kept, and nothing that was
        // skipped.
        bookmarks.save(&"res-1".parse().unwrap(), "p-res-1-1");
        bookmarks
            .storage()
            .set("semiont.cache.kb-a.resource", "{}")
            .expect("written");
        let written: Value =
            serde_json::from_str(&storage.get(KEY).expect("places")).expect("JSON");
        assert_eq!(
            written,
            serde_json::json!({"res-1": "p-res-1-1", "res-3": "p-res-3-4"})
        );
    }

    #[test]
    fn an_id_that_is_no_recorded_events_is_no_place() {
        let storage = Arc::new(InMemorySessionStorage::new());
        let bookmarks = CoupledBookmarks::new(storage.clone(), KEY);
        bookmarks.save(&"res-1".parse().unwrap(), "e-res-1-7");
        bookmarks.save(&"res-2".parse().unwrap(), "p-7");
        bookmarks
            .storage()
            .set("semiont.cache.kb-a.resource", "{}")
            .expect("written");
        assert_eq!(storage.get(KEY), None);
    }

    /// A storage that holds what it has, and takes no write of the cache
    /// `CACHE` names.
    #[derive(Default)]
    struct Full(InMemorySessionStorage);

    const CACHE: &str = "semiont.cache.kb-a.resource";

    impl SessionStorage for Full {
        fn get(&self, key: &str) -> Option<String> {
            self.0.get(key)
        }

        fn set(
            &self,
            key: &str,
            value: &str,
        ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            if key == CACHE {
                return Err("the storage is full".into());
            }
            self.0.set(key, value)
        }

        fn delete(&self, key: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            self.0.delete(key)
        }

        fn update(
            &self,
            key: &str,
            change: &mut dyn FnMut(Option<&str>) -> Option<String>,
        ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            match change(self.0.get(key).as_deref()) {
                Some(next) => self.set(key, &next),
                None => self.delete(key),
            }
        }

        fn subscribe(&self, _: StorageChange) -> Option<StorageSubscription> {
            None
        }
    }

    #[test]
    fn a_place_is_written_after_the_caches_own_write_so_one_that_fails_leaves_no_place_ahead_of_it()
    {
        let storage = Arc::new(Full::default());
        let bookmarks = CoupledBookmarks::new(storage.clone(), KEY);
        bookmarks.save(&"res-1".parse().unwrap(), "p-res-1-7");

        let failed = bookmarks.storage().set(CACHE, "{}");
        assert_eq!(
            failed.map_err(|error| error.to_string()),
            Err("the storage is full".to_owned())
        );
        // The cache kept nothing of what the place names, and no place says it did.
        assert_eq!(storage.get(KEY), None);
        bookmarks
            .storage()
            .set("semiont.cache.kb-a.annotations", "{}")
            .expect("written");
        assert_eq!(bookmarks.load(), places(&[("res-1", "p-res-1-7")]));
    }
}
