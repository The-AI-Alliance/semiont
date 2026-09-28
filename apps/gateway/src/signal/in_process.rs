//! The in-process plane: the fabric is the process. Every subscription to a
//! channel and scope receives each frame as it is ingested, in order, and the
//! count of them is exact.

use super::{
    ClientSubscription, Frame, IngestReceipt, Meta, OnFrame, SharedTable, SignalPlane,
    Subscription, TableWatcher, Unavailable,
};
use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

type Route = (Option<String>, String);

#[derive(Default)]
struct Routes {
    by_route: HashMap<Route, Vec<(u64, OnFrame)>>,
}

pub struct InProcessPlane {
    routes: Arc<Mutex<Routes>>,
    next: AtomicU64,
    tables: Mutex<HashMap<String, Arc<MemoryTable>>>,
}

impl InProcessPlane {
    pub fn new() -> InProcessPlane {
        InProcessPlane {
            routes: Arc::new(Mutex::new(Routes::default())),
            next: AtomicU64::new(0),
            tables: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for InProcessPlane {
    fn default() -> Self {
        Self::new()
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

impl SignalPlane for InProcessPlane {
    fn available(&self) -> bool {
        true
    }

    fn ingest(
        &self,
        channel: String,
        payload: Value,
        scope: Option<String>,
        meta: Option<Meta>,
    ) -> BoxFuture<'_, Result<IngestReceipt, Unavailable>> {
        let targets: Vec<OnFrame> = locked(&self.routes)
            .by_route
            .get(&(scope.clone(), channel.clone()))
            .map(|subs| subs.iter().map(|(_, f)| f.clone()).collect())
            .unwrap_or_default();
        let frame = Frame {
            channel,
            payload: Arc::new(payload),
            scope,
            meta,
        };
        for deliver in &targets {
            deliver(frame.clone());
        }
        async move {
            Ok(IngestReceipt {
                observers: Some(targets.len()),
            })
        }
        .boxed()
    }

    fn subscribe_client(
        &self,
        subscription: ClientSubscription,
    ) -> BoxFuture<'_, Result<Subscription, String>> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut held: Vec<Route> = subscription
            .global
            .iter()
            .map(|c| (None, c.clone()))
            .collect();
        for entry in &subscription.scoped {
            held.extend(
                entry
                    .channels
                    .iter()
                    .map(|c| (Some(entry.scope.clone()), c.clone())),
            );
        }
        {
            let mut routes = locked(&self.routes);
            for route in &held {
                routes
                    .by_route
                    .entry(route.clone())
                    .or_default()
                    .push((id, subscription.on_frame.clone()));
            }
        }
        let routes: Weak<Mutex<Routes>> = Arc::downgrade(&self.routes);
        let handle = Subscription::new(move || {
            let Some(routes) = routes.upgrade() else {
                return;
            };
            let mut routes = locked(&routes);
            for route in held {
                if let Some(subs) = routes.by_route.get_mut(&route) {
                    subs.retain(|(held_by, _)| *held_by != id);
                    if subs.is_empty() {
                        routes.by_route.remove(&route);
                    }
                }
            }
        });
        async move { Ok(handle) }.boxed()
    }

    fn flush(&self) -> BoxFuture<'_, Result<(), String>> {
        // Delivery here happens inside `ingest`: nothing is ever in flight.
        async { Ok(()) }.boxed()
    }

    fn table(
        &self,
        name: String,
        ttl: Duration,
    ) -> BoxFuture<'_, Result<Arc<dyn SharedTable>, String>> {
        let table = {
            let mut tables = locked(&self.tables);

            tables
                .entry(name.clone())
                .or_insert_with(|| Arc::new(MemoryTable::new(ttl)))
                .clone()
        };
        let outcome: Result<Arc<dyn SharedTable>, String> = if table.ttl == ttl {
            Ok(table)
        } else {
            Err(format!(
                "signal plane: table \"{name}\" is already open with a TTL of {:?}, not {ttl:?}",
                table.ttl
            ))
        };
        async move { outcome }.boxed()
    }
}

/// A shared table in one process: every handle on a name is this one map,
/// insertion-ordered so the expired entries are a prefix a sweep walks.
struct MemoryTable {
    ttl: Duration,
    state: Arc<Mutex<TableState>>,
}

#[derive(Default)]
struct TableState {
    order: VecDeque<(String, Instant)>,
    entries: HashMap<String, (String, Instant)>,
    watchers: Vec<(u64, TableWatcher)>,
    next_watcher: u64,
}

impl MemoryTable {
    fn new(ttl: Duration) -> MemoryTable {
        MemoryTable {
            ttl,
            state: Arc::new(Mutex::new(TableState::default())),
        }
    }
}

impl TableState {
    fn sweep(&mut self, ttl: Duration) {
        while let Some((key, at)) = self.order.front() {
            if at.elapsed() < ttl {
                break;
            }
            if self
                .entries
                .get(key)
                .is_some_and(|(_, stored)| stored == at)
            {
                self.entries.remove(key);
            }
            self.order.pop_front();
        }
    }
}

impl MemoryTable {
    /// Write `key` and tell every watcher, when `write` says to.
    fn write(&self, key: &str, value: &str, write: impl FnOnce(&TableState) -> bool) -> bool {
        let watchers: Option<Vec<TableWatcher>> = {
            let mut state = locked(&self.state);
            state.sweep(self.ttl);
            if write(&state) {
                let now = Instant::now();
                state
                    .entries
                    .insert(key.to_owned(), (value.to_owned(), now));
                state.order.push_back((key.to_owned(), now));
                Some(state.watchers.iter().map(|(_, w)| w.clone()).collect())
            } else {
                None
            }
        };
        let written = watchers.is_some();
        for watcher in watchers.unwrap_or_default() {
            watcher(key.to_owned(), Some(value.to_owned()));
        }
        written
    }
}

impl SharedTable for MemoryTable {
    fn create(&self, key: String, value: String) -> BoxFuture<'_, Result<bool, String>> {
        let created = self.write(&key, &value, |state| !state.entries.contains_key(&key));
        async move { Ok(created) }.boxed()
    }

    fn put(&self, key: String, value: String) -> BoxFuture<'_, Result<(), String>> {
        self.write(&key, &value, |_| true);
        async { Ok(()) }.boxed()
    }

    fn delete(&self, key: String) -> BoxFuture<'_, Result<(), String>> {
        let watchers: Vec<TableWatcher> = {
            let mut state = locked(&self.state);
            state.sweep(self.ttl);
            if state.entries.remove(&key).is_some() {
                state.watchers.iter().map(|(_, w)| w.clone()).collect()
            } else {
                Vec::new()
            }
        };
        for watcher in watchers {
            watcher(key.clone(), None);
        }
        async { Ok(()) }.boxed()
    }

    fn read(&self, key: String) -> BoxFuture<'_, Result<Option<String>, String>> {
        let value = {
            let mut state = locked(&self.state);
            state.sweep(self.ttl);
            state.entries.get(&key).map(|(value, _)| value.clone())
        };
        async move { Ok(value) }.boxed()
    }

    fn watch(&self, on_entry: TableWatcher) -> BoxFuture<'_, Result<Subscription, String>> {
        let (present, id) = {
            let mut state = locked(&self.state);
            state.sweep(self.ttl);
            let present: Vec<(String, String)> = state
                .order
                .iter()
                .filter_map(|(key, at)| {
                    state
                        .entries
                        .get(key)
                        .filter(|(_, stored)| stored == at)
                        .map(|(v, _)| (key.clone(), v.clone()))
                })
                .collect();
            let id = state.next_watcher;
            state.next_watcher += 1;
            state.watchers.push((id, on_entry.clone()));
            (present, id)
        };
        for (key, value) in present {
            on_entry(key, Some(value));
        }
        let state = Arc::downgrade(&self.state);
        let handle = Subscription::new(move || {
            if let Some(state) = state.upgrade() {
                locked(&state)
                    .watchers
                    .retain(|(held_by, _)| *held_by != id);
            }
        });
        async move { Ok(handle) }.boxed()
    }
}
