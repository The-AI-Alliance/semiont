//! A storage several contexts share, for tests of what one context does
//! when another writes: each `context` is a handle on the same stored
//! values, and hears what the others write, never what it wrote itself.
//! That is how two windows on one browser storage, and two processes on one
//! file, see each other.

use crate::locked;
use crate::storage::{SessionStorage, StorageChange, StorageSubscription};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Shared {
    stored: HashMap<String, String>,
    /// Each listener, with the context it listens from.
    listeners: Vec<(u64, u64, StorageChange)>,
    contexts: u64,
    subscriptions: u64,
}

/// See the module's documentation.
#[derive(Default)]
pub struct SharedStorage {
    shared: Arc<Mutex<Shared>>,
    context: u64,
}

impl SharedStorage {
    pub fn new() -> SharedStorage {
        SharedStorage::default()
    }

    /// Another context's handle on the same storage.
    pub fn context(&self) -> SharedStorage {
        let mut shared = locked(&self.shared);
        shared.contexts += 1;
        SharedStorage {
            shared: self.shared.clone(),
            context: shared.contexts,
        }
    }

    /// Tell the other contexts' listeners of a change, with nothing locked.
    fn tell(&self, key: &str, value: Option<&str>) {
        let others: Vec<StorageChange> = locked(&self.shared)
            .listeners
            .iter()
            .filter(|(context, _, _)| *context != self.context)
            .map(|(_, _, heard)| heard.clone())
            .collect();
        for heard in others {
            heard(key, value);
        }
    }
}

impl SessionStorage for SharedStorage {
    fn get(&self, key: &str) -> Option<String> {
        locked(&self.shared).stored.get(key).cloned()
    }

    fn set(&self, key: &str, value: &str) {
        locked(&self.shared)
            .stored
            .insert(key.to_owned(), value.to_owned());
        self.tell(key, Some(value));
    }

    fn delete(&self, key: &str) {
        locked(&self.shared).stored.remove(key);
        self.tell(key, None);
    }

    fn update(&self, key: &str, change: &mut dyn FnMut(Option<&str>) -> Option<String>) {
        let next = {
            let mut shared = locked(&self.shared);
            let next = change(shared.stored.get(key).map(String::as_str));
            match &next {
                Some(next) => shared.stored.insert(key.to_owned(), next.clone()),
                None => shared.stored.remove(key),
            };
            next
        };
        self.tell(key, next.as_deref());
    }

    fn subscribe(&self, on_change: StorageChange) -> Option<StorageSubscription> {
        let subscription = {
            let mut shared = locked(&self.shared);
            shared.subscriptions += 1;
            let subscription = shared.subscriptions;
            shared
                .listeners
                .push((self.context, subscription, on_change));
            subscription
        };
        let shared = self.shared.clone();
        Some(StorageSubscription::new(move || {
            locked(&shared)
                .listeners
                .retain(|(_, id, _)| *id != subscription);
        }))
    }
}
