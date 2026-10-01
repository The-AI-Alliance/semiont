//! Where a client keeps what must outlive it: a string under a key. The seam
//! an environment fills in (a file, a platform's store), so nothing above it
//! knows where it runs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Called with a key another context wrote, and its new value, or `None`
/// when it was removed.
pub type StorageChange = Arc<dyn Fn(&str, Option<&str>) + Send + Sync>;

/// A subscription to a storage's changes: it ends when this is dropped.
pub struct StorageSubscription {
    end: Option<Box<dyn FnOnce() + Send>>,
}

impl StorageSubscription {
    pub fn new(end: impl FnOnce() + Send + 'static) -> StorageSubscription {
        StorageSubscription {
            end: Some(Box::new(end)),
        }
    }
}

impl Drop for StorageSubscription {
    fn drop(&mut self) {
        if let Some(end) = self.end.take() {
            end();
        }
    }
}

/// A store of strings by key.
pub trait SessionStorage: Send + Sync + 'static {
    fn get(&self, key: &str) -> Option<String>;

    fn set(&self, key: &str, value: &str);

    /// Remove a key. One that is not there is left not there.
    fn delete(&self, key: &str);

    /// Hear of what another context writes: another process, another window.
    /// `None` where the environment has no such thing; a client then works
    /// correctly within its own.
    fn subscribe(&self, on_change: StorageChange) -> Option<StorageSubscription>;
}

/// A `SessionStorage` kept in memory, for tests and for a client that wants
/// its cache to outlive it within one process. No other context writes it.
#[derive(Default)]
pub struct InMemorySessionStorage {
    stored: Mutex<HashMap<String, String>>,
}

impl InMemorySessionStorage {
    pub fn new() -> InMemorySessionStorage {
        InMemorySessionStorage::default()
    }

    fn stored(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.stored
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl SessionStorage for InMemorySessionStorage {
    fn get(&self, key: &str) -> Option<String> {
        self.stored().get(key).cloned()
    }

    fn set(&self, key: &str, value: &str) {
        self.stored().insert(key.to_owned(), value.to_owned());
    }

    fn delete(&self, key: &str) {
        self.stored().remove(key);
    }

    fn subscribe(&self, _: StorageChange) -> Option<StorageSubscription> {
        None
    }
}
