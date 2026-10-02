//! A read-through cache: what a client's live queries answer from
//! (packages/sdk/docs/CACHE-SEMANTICS.md, B1–B20).
//!
//! **A key has one state, and every observer of the key holds it**: `Pending`
//! (no value yet; a fetch may be in flight), `Ready` (a value, which may be
//! the one shown while a newer is fetched), or `Failed` (a key with no value
//! whose fetch, and its one retry, failed). `Failed` is a state, not the end
//! of anything: an observer lives through it, and the next act on the key
//! tries again.
//!
//! Two ways to read:
//!
//! - `observe` is the live view. The first observer of a key with nothing
//!   starts a fetch; later ones are given what is there. A failed fetch is
//!   tried once more; a key with a value keeps showing it whatever its
//!   refetches do.
//! - `fetch` is the one-shot read. It always asks, gives what it was
//!   answered or the failure it met, and never retries: its caller sees the
//!   failure and decides.
//!
//! `invalidate` asks again and keeps showing the value meanwhile; `set`
//! writes a value that is known; `remove` ends a key whose entity is gone.
//! `dispose` is terminal: every observer's stream ends, and nothing is
//! fetched, retried or failed after it.
//!
//! A cache with a `CachePersister` begins with what was kept and saves its
//! values as they change. A value that was kept is shown at once and asked
//! for again the first time it is observed: nothing says it is still true.

use crate::errors::{BusRequestError, BusRequestErrorCode, SemiontError};
use crate::state_unit::StateUnit;
use crate::storage::{SessionStorage, StorageSubscription};
use crate::transport::BoxFuture;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::hash::Hash;
use std::marker::PhantomData;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
use tokio::task::AbortHandle;
use tokio_stream::wrappers::WatchStream;

/// How long a cache waits, after its values change, before it saves them: a
/// burst of changes is one save.
pub const SAVE_DEBOUNCE: Duration = Duration::from_millis(50);

/// The state of a key.
#[derive(Debug, Clone, PartialEq)]
pub enum CacheState<T> {
    /// No value yet.
    Pending,
    /// A value.
    Ready(T),
    /// No value, and the fetch for one failed, and failed again.
    Failed(SemiontError),
}

impl<T> CacheState<T> {
    /// The value, of a key that has one.
    pub fn ready(&self) -> Option<&T> {
        match self {
            CacheState::Ready(value) => Some(value),
            CacheState::Pending | CacheState::Failed(_) => None,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready().is_some()
    }

    /// The same state, of what `view` makes of its value.
    pub fn map<U>(self, view: impl FnOnce(T) -> U) -> CacheState<U> {
        match self {
            CacheState::Pending => CacheState::Pending,
            CacheState::Ready(value) => CacheState::Ready(view(value)),
            CacheState::Failed(error) => CacheState::Failed(error),
        }
    }
}

/// What a cache's keys are.
pub trait CacheKey: Clone + Eq + Hash + Send + Sync + 'static {}
impl<K: Clone + Eq + Hash + Send + Sync + 'static> CacheKey for K {}

/// What a cache's values are.
pub trait CacheValue: Clone + Send + Sync + 'static {}
impl<V: Clone + Send + Sync + 'static> CacheValue for V {}

/// Where a cache keeps its values so a later one begins with them.
pub trait CachePersister<K, V>: Send + Sync + 'static {
    /// What was kept, asked once, when the cache is built.
    fn load(&self) -> Option<HashMap<K, V>>;

    /// Keep these: the cache's values, after they changed.
    fn save(&self, entries: &HashMap<K, V>);

    /// Hear of what another context saved. `None` where there is no other.
    fn subscribe(
        &self,
        on_external_change: Box<dyn Fn(HashMap<K, V>) + Send + Sync>,
    ) -> Option<StorageSubscription>;
}

type Fetch<K, V> = dyn Fn(K) -> BoxFuture<'static, Result<V, SemiontError>> + Send + Sync;
/// Where a fetch in flight puts what it was answered.
type Outcome<V> = watch::Receiver<Option<Result<V, SemiontError>>>;

struct Key<V> {
    state: watch::Sender<CacheState<V>>,
    /// The fetch in flight for the key: its number, and where its outcome
    /// will be. An `invalidate` lets go of it without waiting, so a fetch
    /// whose answer will never come cannot hold the key.
    in_flight: Option<(u64, Outcome<V>)>,
}

impl<V> Key<V> {
    fn new(state: CacheState<V>) -> Key<V> {
        Key {
            state: watch::channel(state).0,
            in_flight: None,
        }
    }

    /// Whether anything asked for the key and has not let go of it.
    fn known(&self) -> bool {
        self.in_flight.is_some() || !matches!(*self.state.borrow(), CacheState::Pending)
    }
}

struct State<K, V> {
    disposed: bool,
    keys: HashMap<K, Key<V>>,
    /// Keys whose value was kept by an earlier cache and has not been asked
    /// for by this one.
    kept: HashSet<K>,
    fetches: u64,
    /// The wait before the next save, while one is owed.
    saving: Option<AbortHandle>,
    external: Option<StorageSubscription>,
}

struct Inner<K, V>
where
    K: CacheKey,
    V: CacheValue,
{
    fetch: Box<Fetch<K, V>>,
    persister: Option<Arc<dyn CachePersister<K, V>>>,
    save_debounce: Duration,
    state: Mutex<State<K, V>>,
}

fn closed() -> SemiontError {
    BusRequestError::new(BusRequestErrorCode::Closed, "The client is closed").into()
}

async fn outcome<V: Clone>(mut of: Outcome<V>) -> Result<V, SemiontError> {
    loop {
        if let Some(outcome) = of.borrow_and_update().clone() {
            return outcome;
        }
        if of.changed().await.is_err() {
            return Err(closed());
        }
    }
}

impl<K, V> Inner<K, V>
where
    K: CacheKey,
    V: CacheValue,
{
    fn state(&self) -> MutexGuard<'_, State<K, V>> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn values(state: &State<K, V>) -> HashMap<K, V> {
        state
            .keys
            .iter()
            .filter_map(|(key, held)| {
                held.state
                    .borrow()
                    .ready()
                    .map(|value| (key.clone(), value.clone()))
            })
            .collect()
    }

    /// The values changed: save them once they have stopped changing.
    fn owe_a_save(self: &Arc<Self>, state: &mut State<K, V>) {
        if self.persister.is_none() || state.disposed {
            return;
        }
        if let Some(waiting) = state.saving.take() {
            waiting.abort();
        }
        let cache = Arc::downgrade(self);
        let wait = self.save_debounce;
        state.saving = Some(
            tokio::spawn(async move {
                tokio::time::sleep(wait).await;
                if let Some(cache) = Weak::upgrade(&cache) {
                    let entries = {
                        let mut state = cache.state();
                        state.saving = None;
                        Inner::values(&state)
                    };
                    if let Some(persister) = &cache.persister {
                        persister.save(&entries);
                    }
                }
            })
            .abort_handle(),
        );
    }

    /// Start a fetch for `key`, or join the one in flight.
    fn fetching(self: &Arc<Self>, key: &K) -> Outcome<V> {
        let mut state = self.state();
        // Asked for by this cache now, whichever path asked.
        state.kept.remove(key);
        state.fetches += 1;
        let number = state.fetches;
        let held = state
            .keys
            .entry(key.clone())
            .or_insert_with(|| Key::new(CacheState::Pending));
        if let Some((_, in_flight)) = &held.in_flight {
            return in_flight.clone();
        }
        let (answered, outcome) = watch::channel(None);
        held.in_flight = Some((number, outcome.clone()));
        drop(state);

        let cache = self.clone();
        let key = key.clone();
        tokio::spawn(async move {
            let fetched = (cache.fetch)(key.clone()).await;
            {
                let mut state = cache.state();
                let changed = match state.keys.get_mut(&key) {
                    Some(held) => {
                        // Only its own: an `invalidate` may have put a newer
                        // fetch in its place.
                        if held.in_flight.as_ref().is_some_and(|(of, _)| *of == number) {
                            held.in_flight = None;
                        }
                        // A value from any fetch is written, the newest
                        // last: each is at least as new as what was there.
                        // A failure writes nothing.
                        match &fetched {
                            Ok(value) => {
                                held.state.send_replace(CacheState::Ready(value.clone()));
                                true
                            }
                            Err(_) => false,
                        }
                    }
                    // Disposed while it was in flight.
                    None => false,
                };
                if changed {
                    cache.owe_a_save(&mut state);
                }
            }
            let _ = answered.send(Some(fetched));
        });
        outcome
    }

    /// Fetch for the live view: a failure is tried once more, and a key with
    /// no value whose retry also fails becomes `Failed`.
    fn revalidate(self: &Arc<Self>, key: &K) {
        let cache = self.clone();
        let key = key.clone();
        let first = self.fetching(&key);
        tokio::spawn(async move {
            if outcome(first).await.is_ok() || cache.state().disposed {
                return;
            }
            let Err(failure) = outcome(cache.fetching(&key)).await else {
                return;
            };
            let state = cache.state();
            if let Some(held) = state.keys.get(&key)
                && !held.state.borrow().is_ready()
            {
                held.state.send_replace(CacheState::Failed(failure));
            }
        });
    }
}

impl<K, V> Drop for Inner<K, V>
where
    K: CacheKey,
    V: CacheValue,
{
    /// A cache nobody holds any more, and nobody disposed: the save it owed
    /// is made, as disposal makes it.
    fn drop(&mut self) {
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(waiting) = state.saving.take() {
            waiting.abort();
            if let Some(persister) = &self.persister {
                persister.save(&Inner::values(state));
            }
        }
    }
}

/// See the module's documentation. A `Cache` is a handle: its clones are the
/// same cache.
pub struct Cache<K: CacheKey, V: CacheValue> {
    inner: Arc<Inner<K, V>>,
}

impl<K: CacheKey, V: CacheValue> Clone for Cache<K, V> {
    fn clone(&self) -> Cache<K, V> {
        Cache {
            inner: self.inner.clone(),
        }
    }
}

impl<K, V> Cache<K, V>
where
    K: CacheKey,
    V: CacheValue,
{
    /// A cache that fetches a key's value with `fetch`, and keeps nothing
    /// beyond its own life.
    pub fn new<F, Fut>(fetch: F) -> Cache<K, V>
    where
        F: Fn(K) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<V, SemiontError>> + Send + 'static,
    {
        Cache::build(fetch, None, SAVE_DEBOUNCE)
    }

    /// A cache that begins with what `persister` kept, and saves its values
    /// there `save_debounce` after they last changed.
    pub fn persisted<F, Fut>(
        fetch: F,
        persister: Arc<dyn CachePersister<K, V>>,
        save_debounce: Duration,
    ) -> Cache<K, V>
    where
        F: Fn(K) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<V, SemiontError>> + Send + 'static,
    {
        Cache::build(fetch, Some(persister), save_debounce)
    }

    fn build<F, Fut>(
        fetch: F,
        persister: Option<Arc<dyn CachePersister<K, V>>>,
        save_debounce: Duration,
    ) -> Cache<K, V>
    where
        F: Fn(K) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<V, SemiontError>> + Send + 'static,
    {
        let kept = persister
            .as_ref()
            .and_then(|persister| persister.load())
            .unwrap_or_default();
        let inner = Arc::new(Inner {
            fetch: Box::new(move |key| Box::pin(fetch(key))),
            save_debounce,
            state: Mutex::new(State {
                disposed: false,
                kept: kept.keys().cloned().collect(),
                keys: kept
                    .into_iter()
                    .map(|(key, value)| (key, Key::new(CacheState::Ready(value))))
                    .collect(),
                fetches: 0,
                saving: None,
                external: None,
            }),
            persister,
        });
        if let Some(persister) = &inner.persister {
            let cache = Arc::downgrade(&inner);
            let subscription = persister.subscribe(Box::new(move |entries| {
                let Some(cache) = cache.upgrade() else {
                    return;
                };
                // What another context saved is what this one now has. It is
                // not saved back: a save answered with a save never ends.
                let mut state = cache.state();
                if state.disposed {
                    return;
                }
                for (key, value) in entries {
                    state
                        .keys
                        .entry(key)
                        .or_insert_with(|| Key::new(CacheState::Pending))
                        .state
                        .send_replace(CacheState::Ready(value));
                }
            }));
            inner.state().external = subscription;
        }
        Cache { inner }
    }

    /// The key's state, now and as it changes, until the cache is disposed.
    /// Observing is what asks: a key with nothing is fetched, a failed key
    /// is tried again, and a value an earlier cache kept is asked for anew
    /// while it is shown.
    pub fn observe(&self, key: &K) -> WatchStream<CacheState<V>> {
        let mut state = self.inner.state();
        if state.disposed {
            return WatchStream::from_changes(watch::channel(CacheState::Pending).1);
        }
        let was_kept = state.kept.contains(key);
        let held = state
            .keys
            .entry(key.clone())
            .or_insert_with(|| Key::new(CacheState::Pending));
        let asks = match &*held.state.borrow() {
            CacheState::Failed(_) => true,
            CacheState::Ready(_) => was_kept,
            CacheState::Pending => held.in_flight.is_none(),
        };
        // An observer arriving at a failed key starts over, for everyone:
        // a fetch is in flight for all of them.
        held.state.send_if_modified(|current| {
            let failed = matches!(current, CacheState::Failed(_));
            if failed {
                *current = CacheState::Pending;
            }
            failed
        });
        let observing = WatchStream::new(held.state.subscribe());
        drop(state);
        if asks {
            self.inner.revalidate(key);
        }
        observing
    }

    /// Ask for the key's value now: what the service answers, which every
    /// observer of the key is given too, or the failure, which only this
    /// caller is. Concurrent asks for one key share one fetch.
    pub fn fetch(&self, key: &K) -> impl Future<Output = Result<V, SemiontError>> + Send + 'static {
        let cache = self.inner.clone();
        let key = key.clone();
        async move {
            if cache.state().disposed {
                return Err(closed());
            }
            outcome(cache.fetching(&key)).await
        }
    }

    /// The key's value now, asking for nothing.
    pub fn get(&self, key: &K) -> Option<V> {
        let state = self.inner.state();
        let held = state.keys.get(key)?;
        held.state.borrow().ready().cloned()
    }

    /// Whether anything has asked for the key and not let go of it: it has a
    /// value or a failure, or a fetch for it is in flight.
    pub fn known(&self, key: &K) -> bool {
        self.inner.state().keys.get(key).is_some_and(Key::known)
    }

    /// Every key the cache knows.
    pub fn keys(&self) -> Vec<K> {
        self.inner
            .state()
            .keys
            .iter()
            .filter(|(_, held)| held.known())
            .map(|(key, _)| key.clone())
            .collect()
    }

    /// The key's value is out of date: ask again, showing what there is
    /// meanwhile. A fetch already in flight is not waited on: its answer may
    /// never come.
    pub fn invalidate(&self, key: &K) {
        {
            let mut state = self.inner.state();
            if state.disposed {
                return;
            }
            let held = state
                .keys
                .entry(key.clone())
                .or_insert_with(|| Key::new(CacheState::Pending));
            held.in_flight = None;
            held.state.send_if_modified(|current| {
                let failed = matches!(current, CacheState::Failed(_));
                if failed {
                    *current = CacheState::Pending;
                }
                failed
            });
        }
        self.inner.revalidate(key);
    }

    /// `invalidate`, of every key the cache knows.
    pub fn invalidate_all(&self) {
        for key in self.keys() {
            self.invalidate(&key);
        }
    }

    /// The key's entity is gone: its value is dropped and the key is failed
    /// with `gone`, at once, for every observer. Nothing is asked for.
    pub fn remove(&self, key: &K, gone: SemiontError) {
        let mut state = self.inner.state();
        if state.disposed {
            return;
        }
        state.kept.remove(key);
        let held = state
            .keys
            .entry(key.clone())
            .or_insert_with(|| Key::new(CacheState::Pending));
        held.in_flight = None;
        held.state.send_replace(CacheState::Failed(gone));
        self.inner.owe_a_save(&mut state);
    }

    /// The key's value is known: write it, asking for nothing.
    pub fn set(&self, key: &K, value: V) {
        let mut state = self.inner.state();
        if state.disposed {
            return;
        }
        state.kept.remove(key);
        state
            .keys
            .entry(key.clone())
            .or_insert_with(|| Key::new(CacheState::Pending))
            .state
            .send_replace(CacheState::Ready(value));
        self.inner.owe_a_save(&mut state);
    }

    /// Whether what the cache holds may be ahead of what it has saved: a
    /// fetch is in flight, or a save is owed.
    pub fn persistence_pending(&self) -> bool {
        let state = self.inner.state();
        state.saving.is_some() || state.keys.values().any(|held| held.in_flight.is_some())
    }
}

impl<K, V> StateUnit for Cache<K, V>
where
    K: CacheKey,
    V: CacheValue,
{
    /// End the cache: a save that was owed is made now, every observer's
    /// stream ends, and nothing is fetched or written after.
    fn dispose(&self) {
        let owed = {
            let mut state = self.inner.state();
            if state.disposed {
                return;
            }
            state.disposed = true;
            let owed = state.saving.take().map(|waiting| {
                waiting.abort();
                Inner::values(&state)
            });
            state.external = None;
            state.kept.clear();
            state.keys.clear();
            owed
        };
        if let (Some(entries), Some(persister)) = (owed, &self.inner.persister) {
            persister.save(&entries);
        }
    }
}

// ── Keeping a cache in a `SessionStorage` ───────────────────────────────

/// The largest document a persister writes, in bytes, unless told another.
pub const MAX_STORED_BYTES: usize = 2 * 1024 * 1024;

/// One entry as it is stored: the key, the value, and when the value was
/// last written, in milliseconds since the epoch.
type Stored = (Value, Value, u64);

#[derive(Serialize, serde::Deserialize)]
struct Document {
    version: u64,
    #[serde(rename = "writtenAt")]
    written_at: u64,
    entries: Vec<Stored>,
}

/// A `CachePersister` over a `SessionStorage`: the cache's values as one
/// document under one key, `{version, writtenAt, entries}`.
///
/// A document of another version, or one that does not parse, reads as
/// nothing kept. A document larger than `max_bytes` loses its entries that
/// have gone longest without a new value, until it fits.
pub struct StoragePersister<K, V> {
    storage: Arc<dyn SessionStorage>,
    storage_key: String,
    version: u64,
    max_bytes: usize,
    /// Each key's value as last written, and when: an entry whose value has
    /// not changed keeps its time.
    written: Arc<Mutex<HashMap<String, (String, u64)>>>,
    of: PhantomData<fn() -> (K, V)>,
}

impl<K, V> StoragePersister<K, V> {
    pub fn new(
        storage: Arc<dyn SessionStorage>,
        storage_key: impl Into<String>,
        version: u64,
        max_bytes: usize,
    ) -> StoragePersister<K, V> {
        StoragePersister {
            storage,
            storage_key: storage_key.into(),
            version,
            max_bytes,
            written: Arc::new(Mutex::new(HashMap::new())),
            of: PhantomData,
        }
    }
}

fn document(raw: Option<&str>, version: u64) -> Option<Document> {
    let document: Document = serde_json::from_str(raw?).ok()?;
    (document.version == version).then_some(document)
}

fn remembered(written: &Mutex<HashMap<String, (String, u64)>>, document: &Document) {
    *written
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = document
        .entries
        .iter()
        .map(|(key, value, at)| (key.to_string(), (value.to_string(), *at)))
        .collect();
}

fn entries<K, V>(document: Document) -> HashMap<K, V>
where
    K: DeserializeOwned + Eq + Hash,
    V: DeserializeOwned,
{
    // An entry that is not this cache's shape is one it never kept.
    document
        .entries
        .into_iter()
        .filter_map(|(key, value, _)| {
            Some((
                serde_json::from_value(key).ok()?,
                serde_json::from_value(value).ok()?,
            ))
        })
        .collect()
}

impl<K, V> CachePersister<K, V> for StoragePersister<K, V>
where
    K: Serialize + DeserializeOwned + Eq + Hash + 'static,
    V: Serialize + DeserializeOwned + 'static,
{
    fn load(&self) -> Option<HashMap<K, V>> {
        let document = document(self.storage.get(&self.storage_key).as_deref(), self.version)?;
        remembered(&self.written, &document);
        Some(entries(document))
    }

    fn save(&self, entries: &HashMap<K, V>) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| {
                u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
            });
        let mut written = self
            .written
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut stored: Vec<Stored> = Vec::new();
        for (key, value) in entries {
            let (Ok(key), Ok(value)) = (serde_json::to_value(key), serde_json::to_value(value))
            else {
                continue;
            };
            let as_text = value.to_string();
            let at = match written.get(&key.to_string()) {
                Some((as_written, at)) if *as_written == as_text => *at,
                _ => now,
            };
            stored.push((key, value, at));
        }
        let serialized = |entries: &[Stored]| {
            serde_json::to_string(&Document {
                version: self.version,
                written_at: now,
                entries: entries.to_vec(),
            })
            .unwrap_or_default()
        };
        let mut text = serialized(&stored);
        if text.len() > self.max_bytes {
            stored.sort_by_key(|(_, _, at)| *at);
            while !stored.is_empty() && text.len() > self.max_bytes {
                stored.remove(0);
                text = serialized(&stored);
            }
        }
        *written = stored
            .iter()
            .map(|(key, value, at)| (key.to_string(), (value.to_string(), *at)))
            .collect();
        drop(written);
        self.storage.set(&self.storage_key, &text);
    }

    fn subscribe(
        &self,
        on_external_change: Box<dyn Fn(HashMap<K, V>) + Send + Sync>,
    ) -> Option<StorageSubscription> {
        let storage_key = self.storage_key.clone();
        let version = self.version;
        let written = self.written.clone();
        self.storage.subscribe(Arc::new(move |key, value| {
            if key != storage_key {
                return;
            }
            if let Some(document) = document(value, version) {
                remembered(&written, &document);
                on_external_change(entries(document));
            }
        }))
    }
}
