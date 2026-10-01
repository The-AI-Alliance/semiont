//! A stream's place in each scope, kept so the next client for the same
//! knowledge base resumes from it: what that client kept of a scope is then
//! brought up to date by the events recorded since, replayed.
//!
//! **The place may lag the caches and never leads them.** A place kept
//! ahead of a cache would have the next client resume past an event the
//! cache it rehydrates never took in. So a place is not written when it is
//! reached. It is remembered, and written with the next write of a cache,
//! and only when the gate says every kept cache is at rest: one that is
//! still fetching, or owes a save, has not taken in the event the place
//! names. A place that is not written is only late, which costs a replay.
//!
//! What is kept under the key and is not places reads as nothing kept.

use crate::locked;
use crate::storage::{SessionStorage, StorageChange, StorageSubscription};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

type Gate = Box<dyn Fn() -> bool + Send + Sync>;

struct Coupling {
    storage: Arc<dyn SessionStorage>,
    key: String,
    /// The places reached and not yet written.
    pending: Mutex<HashMap<String, String>>,
    gate: Mutex<Option<Gate>>,
}

impl Coupling {
    fn stored(stored: Option<&str>) -> HashMap<String, String> {
        stored
            .and_then(|stored| serde_json::from_str(stored).ok())
            .unwrap_or_default()
    }

    /// Write what is remembered, when the gate allows it.
    fn flush(&self) {
        let reached = {
            let mut pending = locked(&self.pending);
            let at_rest = locked(&self.gate).as_ref().is_none_or(|gate| gate());
            if pending.is_empty() || !at_rest {
                return;
            }
            std::mem::take(&mut *pending)
        };
        self.storage.update(&self.key, &mut |stored| {
            let mut places = Coupling::stored(stored);
            places.extend(reached.clone());
            // A map of strings always serializes.
            serde_json::to_string(&places).ok()
        });
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
                pending: Mutex::new(HashMap::new()),
                gate: Mutex::new(None),
            }),
        }
    }

    /// The places kept, by scope.
    pub fn load(&self) -> HashMap<String, String> {
        Coupling::stored(self.coupling.storage.get(&self.coupling.key).as_deref())
    }

    /// A place was reached in `scope`. Remembered, and written with a later
    /// write of a cache.
    pub fn save(&self, scope: &str, event_id: &str) {
        locked(&self.coupling.pending).insert(scope.to_owned(), event_id.to_owned());
    }

    /// Say when the caches are at rest. With no gate every write of a cache
    /// carries what is remembered.
    pub fn set_flush_gate(&self, at_rest: impl Fn() -> bool + Send + Sync + 'static) {
        *locked(&self.coupling.gate) = Some(Box::new(at_rest));
    }

    /// The storage to give the caches: what they write goes to the storage
    /// beneath, and carries the places with it.
    pub fn storage(&self) -> Arc<dyn SessionStorage> {
        Arc::new(Carrying(self.coupling.clone()))
    }
}

struct Carrying(Arc<Coupling>);

impl SessionStorage for Carrying {
    fn get(&self, key: &str) -> Option<String> {
        self.0.storage.get(key)
    }

    fn set(&self, key: &str, value: &str) {
        self.0.storage.set(key, value);
        self.0.flush();
    }

    fn delete(&self, key: &str) {
        self.0.storage.delete(key);
    }

    fn update(&self, key: &str, change: &mut dyn FnMut(Option<&str>) -> Option<String>) {
        self.0.storage.update(key, change);
        self.0.flush();
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

    fn places(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(scope, id)| ((*scope).to_owned(), (*id).to_owned()))
            .collect()
    }

    #[test]
    fn a_place_is_written_with_the_next_write_of_a_cache_and_not_before() {
        let storage = Arc::new(InMemorySessionStorage::new());
        let bookmarks = CoupledBookmarks::new(storage.clone(), KEY);
        let caches = bookmarks.storage();
        assert!(bookmarks.load().is_empty());

        bookmarks.save("res-1", "p-7");
        bookmarks.save("res-1", "p-8");
        bookmarks.save("res-2", "p-3");
        assert_eq!(storage.get(KEY), None);

        caches.set("semiont.cache.kb-a.resource", "{}");
        assert_eq!(
            storage.get("semiont.cache.kb-a.resource").as_deref(),
            Some("{}")
        );
        assert_eq!(
            bookmarks.load(),
            places(&[("res-1", "p-8"), ("res-2", "p-3")])
        );

        // A later place of one scope leaves the other's as it was.
        bookmarks.save("res-2", "p-4");
        caches.update("semiont.cache.kb-a.resource", &mut |_| {
            Some("{}".to_owned())
        });
        assert_eq!(
            bookmarks.load(),
            places(&[("res-1", "p-8"), ("res-2", "p-4")])
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

        bookmarks.save("res-1", "p-7");
        caches.set("semiont.cache.kb-a.resource", "{}");
        // Late, which is safe: the cache that was written may not be the one
        // still taking the event in.
        assert_eq!(storage.get(KEY), None);

        at_rest.store(true, Ordering::SeqCst);
        caches.set("semiont.cache.kb-a.annotations", "{}");
        assert_eq!(bookmarks.load(), places(&[("res-1", "p-7")]));
    }

    #[test]
    fn what_is_kept_under_the_key_and_is_not_places_is_nothing_kept() {
        let storage = Arc::new(InMemorySessionStorage::new());
        for kept in ["not json", "[1, 2]", r#"{"res-1": 7}"#] {
            storage.set(KEY, kept);
            assert!(
                CoupledBookmarks::new(storage.clone(), KEY)
                    .load()
                    .is_empty(),
                "{kept}"
            );
        }
        // And is written over by the first places that are.
        let bookmarks = CoupledBookmarks::new(storage.clone(), KEY);
        bookmarks.save("res-1", "p-1");
        bookmarks.storage().set("semiont.cache.kb-a.resource", "{}");
        assert_eq!(bookmarks.load(), places(&[("res-1", "p-1")]));
    }
}
