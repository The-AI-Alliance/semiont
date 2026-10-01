//! The cache against packages/sdk/docs/CACHE-SEMANTICS.md, behaviour by
//! behaviour: each test names the clause it holds. The service is a script,
//! so a test decides what each fetch is answered and when.
//!
//! An observer here is read as a watcher reads it: its state now, then each
//! state after. A run of changes nobody read between is its last, so a test
//! that must see a state reads the observer before it causes the next.

use futures_core::Stream;
use semiont::cache::{
    Cache, CachePersister, CacheState, MAX_STORED_BYTES, SAVE_DEBOUNCE, StoragePersister,
};
use semiont::errors::{BusRequestError, BusRequestErrorCode, SemiontError};
use semiont::state_unit::StateUnit;
use semiont::storage::{
    InMemorySessionStorage, SessionStorage, StorageChange, StorageSubscription,
};
use semiont::testing::axioms::{
    AxiomSubject, Fresh, StreamSurface, Surface, assert_state_unit_axioms,
};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio_stream::wrappers::WatchStream;

type Answer = Result<String, SemiontError>;

fn refused(why: &str) -> SemiontError {
    BusRequestError::new(BusRequestErrorCode::Rejected, why).into()
}

enum Scripted {
    Now(Answer),
    When(oneshot::Receiver<Answer>),
}

/// What the cache fetches from: it answers what was scripted, in order, and
/// once the script is spent answers `<key>-v<n>`, the n-th ask of all.
#[derive(Clone, Default)]
struct Service {
    asked: Arc<Mutex<Vec<String>>>,
    script: Arc<Mutex<VecDeque<Scripted>>>,
}

impl Service {
    fn fetching(
        &self,
    ) -> impl Fn(String) -> std::pin::Pin<Box<dyn Future<Output = Answer> + Send>> + Send + Sync + 'static
    {
        let service = self.clone();
        move |key: String| {
            let number = {
                let mut asked = service.asked.lock().expect("asked");
                asked.push(key.clone());
                asked.len()
            };
            let scripted = service.script.lock().expect("script").pop_front();
            Box::pin(async move {
                match scripted {
                    None => Ok(format!("{key}-v{number}")),
                    Some(Scripted::Now(answer)) => answer,
                    Some(Scripted::When(answer)) => answer
                        .await
                        .unwrap_or_else(|_| Err(refused("never answered"))),
                }
            })
        }
    }

    fn cache(&self) -> Cache<String, String> {
        Cache::new(self.fetching())
    }

    /// The next ask is answered this.
    fn then(&self, answer: Answer) {
        self.script
            .lock()
            .expect("script")
            .push_back(Scripted::Now(answer));
    }

    /// The next ask waits for what is sent here.
    fn hold(&self) -> oneshot::Sender<Answer> {
        let (answer, answered) = oneshot::channel();
        self.script
            .lock()
            .expect("script")
            .push_back(Scripted::When(answered));
        answer
    }

    fn asked(&self) -> usize {
        self.asked.lock().expect("asked").len()
    }

    fn asked_for(&self, key: &str) -> usize {
        self.asked
            .lock()
            .expect("asked")
            .iter()
            .filter(|asked| *asked == key)
            .count()
    }
}

fn key(name: &str) -> String {
    name.to_owned()
}

fn ready(value: &str) -> CacheState<String> {
    CacheState::Ready(value.to_owned())
}

/// Let what is ready run: fetches are answered and their states written.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

/// The observer's next state, or `None` at its end. An observer that is
/// given neither is a failure, not a wait: an hour of the test's clock is
/// longer than anything here takes.
async fn next<T>(stream: &mut (impl Stream<Item = T> + Unpin)) -> Option<T> {
    tokio::time::timeout(
        Duration::from_secs(3600),
        std::future::poll_fn(|cx| Pin::new(&mut *stream).poll_next(cx)),
    )
    .await
    .expect("the observer is given a state")
}

/// The state the observer holds once what is ready has run.
async fn holds(observer: &mut WatchStream<CacheState<String>>) -> CacheState<String> {
    settle().await;
    let mut held = None;
    while let Ok(Some(state)) = tokio::time::timeout(Duration::from_millis(1), next(observer)).await
    {
        held = Some(state);
    }
    held.expect("an observer always holds a state")
}

/// Whether the observer's stream has ended.
async fn ended(observer: &mut WatchStream<CacheState<String>>) -> bool {
    loop {
        match tokio::time::timeout(Duration::from_millis(5), next(observer)).await {
            Ok(None) => return true,
            Ok(Some(_)) => {}
            Err(_) => return false,
        }
    }
}

// ── B1–B3: observing ────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn b1_the_first_observation_fetches_and_is_pending_until_it_is_answered() {
    let service = Service::default();
    let answer = service.hold();
    let cache = service.cache();

    let mut observer = cache.observe(&key("a"));
    assert_eq!(holds(&mut observer).await, CacheState::Pending);
    assert_eq!(service.asked(), 1);

    answer.send(Ok(key("one"))).expect("the fetch is waiting");
    assert_eq!(holds(&mut observer).await, ready("one"));
    assert_eq!(service.asked(), 1);
}

#[tokio::test(start_paused = true)]
async fn b2_a_later_observation_is_given_the_value_and_fetches_nothing() {
    let service = Service::default();
    let cache = service.cache();
    let mut first = cache.observe(&key("a"));
    assert_eq!(holds(&mut first).await, ready("a-v1"));

    let mut later = cache.observe(&key("a"));
    assert_eq!(next(&mut later).await, Some(ready("a-v1")));
    settle().await;
    assert_eq!(service.asked(), 1);
}

#[tokio::test(start_paused = true)]
async fn b3_observers_arriving_together_share_one_fetch() {
    let service = Service::default();
    let answer = service.hold();
    let cache = service.cache();
    let mut one = cache.observe(&key("a"));
    let mut other = cache.observe(&key("a"));
    settle().await;
    assert_eq!(service.asked(), 1);

    answer
        .send(Ok(key("shared")))
        .expect("the fetch is waiting");
    assert_eq!(holds(&mut one).await, ready("shared"));
    assert_eq!(holds(&mut other).await, ready("shared"));
}

// ── B5–B10: values, failures, invalidation ──────────────────────────────

#[tokio::test(start_paused = true)]
async fn b5_b7_an_invalidated_key_shows_its_value_until_the_new_one_arrives_and_is_never_pending() {
    let service = Service::default();
    let cache = service.cache();
    let mut observer = cache.observe(&key("a"));
    assert_eq!(holds(&mut observer).await, ready("a-v1"));

    let answer = service.hold();
    cache.invalidate(&key("a"));
    // The refetch is in flight, and the observer was given nothing new.
    settle().await;
    assert_eq!(service.asked(), 2);
    assert!(
        tokio::time::timeout(Duration::from_millis(1), next(&mut observer))
            .await
            .is_err()
    );
    assert_eq!(cache.get(&key("a")), Some(key("a-v1")));

    answer
        .send(Ok(key("newer")))
        .expect("the refetch is waiting");
    assert_eq!(next(&mut observer).await, Some(ready("newer")));
}

#[tokio::test(start_paused = true)]
async fn b6_a_failed_refetch_leaves_the_value_there_was() {
    let service = Service::default();
    let cache = service.cache();
    let mut observer = cache.observe(&key("a"));
    assert_eq!(holds(&mut observer).await, ready("a-v1"));

    service.then(Err(refused("down")));
    service.then(Err(refused("still down")));
    cache.invalidate(&key("a"));
    settle().await;
    // Tried, and tried once more (B14), and the value is still what is shown.
    assert_eq!(service.asked(), 3);
    assert_eq!(cache.get(&key("a")), Some(key("a-v1")));
    assert_eq!(holds(&mut cache.observe(&key("a"))).await, ready("a-v1"));
}

#[tokio::test(start_paused = true)]
async fn b8_invalidating_a_key_nothing_asked_for_fetches_it() {
    let service = Service::default();
    let cache = service.cache();
    cache.invalidate(&key("a"));
    settle().await;
    assert_eq!(service.asked(), 1);
    assert_eq!(cache.get(&key("a")), Some(key("a-v1")));
}

#[tokio::test(start_paused = true)]
async fn b9_an_invalidate_does_not_wait_on_the_fetch_in_flight_and_the_last_answer_stands() {
    let service = Service::default();
    let orphaned = service.hold();
    let cache = service.cache();
    let mut observer = cache.observe(&key("a"));
    settle().await;
    assert_eq!(service.asked(), 1);

    // The fetch in flight may never be answered: the invalidate asks anyway.
    let second = service.hold();
    cache.invalidate(&key("a"));
    settle().await;
    assert_eq!(service.asked(), 2);

    second
        .send(Ok(key("second")))
        .expect("the second fetch is waiting");
    assert_eq!(holds(&mut observer).await, ready("second"));
    // The first, answered after all, is written too: either is at least as
    // new as what was there before.
    orphaned
        .send(Ok(key("first, late")))
        .expect("the first fetch is waiting");
    assert_eq!(holds(&mut observer).await, ready("first, late"));
}

#[tokio::test(start_paused = true)]
async fn b10_keys_are_independent() {
    let service = Service::default();
    let cache = service.cache();
    let mut a = cache.observe(&key("a"));
    let mut b = cache.observe(&key("b"));
    assert_eq!(holds(&mut a).await, ready("a-v1"));
    assert_eq!(holds(&mut b).await, ready("b-v2"));

    service.then(Err(refused("a is down")));
    service.then(Err(refused("a is down")));
    cache.invalidate(&key("a"));
    settle().await;
    assert_eq!(service.asked_for("b"), 1);
    assert_eq!(cache.get(&key("b")), Some(key("b-v2")));
}

// ── B13a, B13b: remove and set ──────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn b13a_a_removed_key_fails_at_once_with_what_it_was_given_and_nothing_is_asked() {
    let service = Service::default();
    let cache = service.cache();
    let mut observer = cache.observe(&key("a"));
    assert_eq!(holds(&mut observer).await, ready("a-v1"));

    cache.remove(&key("a"), refused("gone"));
    // Straight from ready: no pending with no request behind it.
    assert_eq!(
        next(&mut observer).await,
        Some(CacheState::Failed(refused("gone")))
    );
    settle().await;
    assert_eq!(service.asked(), 1);
    assert_eq!(cache.get(&key("a")), None);
    assert!(cache.known(&key("a")));
}

#[tokio::test(start_paused = true)]
async fn b13a_an_observer_arriving_at_a_removed_key_asks_the_service() {
    let service = Service::default();
    let cache = service.cache();
    let mut present = cache.observe(&key("a"));
    holds(&mut present).await;
    cache.remove(&key("a"), refused("gone"));

    let mut arriving = cache.observe(&key("a"));
    assert_eq!(next(&mut arriving).await, Some(CacheState::Pending));
    assert_eq!(holds(&mut arriving).await, ready("a-v2"));
    assert_eq!(service.asked(), 2);
}

#[tokio::test(start_paused = true)]
async fn b13b_a_written_value_is_shown_and_nothing_is_asked() {
    let service = Service::default();
    let cache = service.cache();
    cache.set(&key("a"), key("written"));
    assert_eq!(cache.get(&key("a")), Some(key("written")));

    let mut observer = cache.observe(&key("a"));
    assert_eq!(next(&mut observer).await, Some(ready("written")));
    settle().await;
    assert_eq!(service.asked(), 0);
}

// ── keys, invalidate_all ────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn b20_a_key_is_known_from_the_moment_it_is_asked_for_and_a_failed_key_is_known() {
    let service = Service::default();
    let answer = service.hold();
    let cache = service.cache();
    assert!(!cache.known(&key("a")));
    assert!(cache.keys().is_empty());

    let _observer = cache.observe(&key("a"));
    assert!(cache.known(&key("a")));
    assert_eq!(cache.keys(), [key("a")]);
    answer
        .send(Err(refused("down")))
        .expect("the fetch is waiting");
    service.then(Err(refused("down")));
    settle().await;
    assert_eq!(cache.keys(), [key("a")]);
    assert_eq!(cache.get(&key("a")), None);
}

#[tokio::test(start_paused = true)]
async fn invalidate_all_asks_again_for_each_key_it_knows_a_failed_one_included() {
    let service = Service::default();
    let cache = service.cache();
    holds(&mut cache.observe(&key("a"))).await;
    service.then(Err(refused("down")));
    service.then(Err(refused("down")));
    let mut failed = cache.observe(&key("b"));
    assert!(matches!(holds(&mut failed).await, CacheState::Failed(_)));
    let before = service.asked();

    cache.invalidate_all();
    settle().await;
    assert_eq!(service.asked(), before + 2);
    assert_eq!(service.asked_for("never-asked"), 0);
    assert!(holds(&mut failed).await.is_ready());
}

// ── fetch: the one-shot read ────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn a_one_shot_read_always_asks_and_its_observers_are_given_the_answer() {
    let service = Service::default();
    let cache = service.cache();
    let mut observer = cache.observe(&key("a"));
    assert_eq!(holds(&mut observer).await, ready("a-v1"));

    assert_eq!(cache.fetch(&key("a")).await, Ok(key("a-v2")));
    assert_eq!(holds(&mut observer).await, ready("a-v2"));
}

#[tokio::test(start_paused = true)]
async fn one_shot_reads_made_together_share_one_fetch() {
    let service = Service::default();
    let answer = service.hold();
    let cache = service.cache();
    let one = tokio::spawn(cache.fetch(&key("a")));
    let other = tokio::spawn(cache.fetch(&key("a")));
    settle().await;
    assert_eq!(service.asked(), 1);
    answer
        .send(Ok(key("shared")))
        .expect("the fetch is waiting");
    assert_eq!(one.await.expect("the read ran"), Ok(key("shared")));
    assert_eq!(other.await.expect("the read ran"), Ok(key("shared")));
}

#[tokio::test(start_paused = true)]
async fn b14_a_one_shot_read_that_fails_is_not_tried_again_and_fails_only_its_caller() {
    let service = Service::default();
    let cache = service.cache();
    let mut observer = cache.observe(&key("a"));
    assert_eq!(holds(&mut observer).await, ready("a-v1"));

    service.then(Err(refused("down")));
    assert_eq!(cache.fetch(&key("a")).await, Err(refused("down")));
    settle().await;
    assert_eq!(service.asked(), 2);
    assert_eq!(cache.get(&key("a")), Some(key("a-v1")));
}

// ── B14, B15: the retry, and the failure of a key with no value ─────────

#[tokio::test(start_paused = true)]
async fn b14_a_failed_fetch_is_tried_once_more_and_its_observers_recover() {
    let service = Service::default();
    service.then(Err(refused("a blip")));
    let cache = service.cache();
    let mut observer = cache.observe(&key("a"));
    assert_eq!(holds(&mut observer).await, ready("a-v2"));
    assert_eq!(service.asked(), 2);
}

#[tokio::test(start_paused = true)]
async fn b14_b15_a_key_that_keeps_failing_is_failed_after_one_retry_and_no_more_is_asked() {
    let service = Service::default();
    service.then(Err(refused("down")));
    service.then(Err(refused("still down")));
    let cache = service.cache();
    let mut observer = cache.observe(&key("a"));
    assert_eq!(
        holds(&mut observer).await,
        CacheState::Failed(refused("still down"))
    );
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(service.asked(), 2);
    // The stream lives through the failure.
    assert!(!ended(&mut observer).await);
}

#[tokio::test(start_paused = true)]
async fn b15_an_observer_arriving_at_a_failed_key_starts_over_and_the_one_present_is_pending_too() {
    let service = Service::default();
    service.then(Err(refused("down")));
    service.then(Err(refused("down")));
    let cache = service.cache();
    let mut present = cache.observe(&key("a"));
    assert!(matches!(holds(&mut present).await, CacheState::Failed(_)));

    let answer = service.hold();
    let mut arriving = cache.observe(&key("a"));
    assert_eq!(next(&mut arriving).await, Some(CacheState::Pending));
    assert_eq!(next(&mut present).await, Some(CacheState::Pending));

    answer
        .send(Ok(key("recovered")))
        .expect("the fetch is waiting");
    assert_eq!(holds(&mut arriving).await, ready("recovered"));
    assert_eq!(holds(&mut present).await, ready("recovered"));
}

#[tokio::test(start_paused = true)]
async fn b15_a_recovery_that_fails_again_gives_every_observer_its_own_failure() {
    let service = Service::default();
    for why in ["first", "first again", "second", "second again"] {
        service.then(Err(refused(why)));
    }
    let cache = service.cache();
    let mut present = cache.observe(&key("a"));
    assert_eq!(
        holds(&mut present).await,
        CacheState::Failed(refused("first again"))
    );
    let mut arriving = cache.observe(&key("a"));
    assert_eq!(
        holds(&mut arriving).await,
        CacheState::Failed(refused("second again"))
    );
    assert_eq!(
        holds(&mut present).await,
        CacheState::Failed(refused("second again"))
    );
}

#[tokio::test(start_paused = true)]
async fn b15_invalidate_returns_a_failed_key_to_pending_and_a_value_moves_it_straight_to_ready() {
    let service = Service::default();
    service.then(Err(refused("down")));
    service.then(Err(refused("down")));
    let cache = service.cache();
    let mut observer = cache.observe(&key("a"));
    assert!(matches!(holds(&mut observer).await, CacheState::Failed(_)));

    let answer = service.hold();
    cache.invalidate(&key("a"));
    assert_eq!(next(&mut observer).await, Some(CacheState::Pending));
    answer
        .send(Err(refused("down")))
        .expect("the fetch is waiting");
    service.then(Err(refused("down")));
    assert!(matches!(holds(&mut observer).await, CacheState::Failed(_)));

    // A value written to a failed key: ready, with no pending between.
    cache.set(&key("a"), key("written"));
    assert_eq!(next(&mut observer).await, Some(ready("written")));
}

#[tokio::test(start_paused = true)]
async fn b15_a_one_shot_read_that_succeeds_ends_the_failure_for_everyone() {
    let service = Service::default();
    service.then(Err(refused("down")));
    service.then(Err(refused("down")));
    let cache = service.cache();
    let mut observer = cache.observe(&key("a"));
    assert!(matches!(holds(&mut observer).await, CacheState::Failed(_)));

    assert_eq!(cache.fetch(&key("a")).await, Ok(key("a-v3")));
    assert_eq!(next(&mut observer).await, Some(ready("a-v3")));
    // And a later observer is given the value, asking nothing.
    assert_eq!(
        next(&mut cache.observe(&key("a"))).await,
        Some(ready("a-v3"))
    );
    settle().await;
    assert_eq!(service.asked(), 3);
}

// ── B16: disposal ───────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn b16_disposal_ends_every_observer_and_a_fetch_that_straddles_it_goes_quiet() {
    let service = Service::default();
    let straddling = service.hold();
    let cache = service.cache();
    let mut observer = cache.observe(&key("a"));
    assert_eq!(holds(&mut observer).await, CacheState::Pending);

    cache.dispose();
    cache.dispose();
    assert!(ended(&mut observer).await);

    // The fetch in flight fails after disposal: not tried again, and no
    // failure is given to anyone.
    straddling
        .send(Err(refused("closed under it")))
        .expect("the fetch is waiting");
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(service.asked(), 1);
}

#[tokio::test(start_paused = true)]
async fn b16_a_disposed_cache_asks_nothing_and_a_one_shot_read_of_it_fails_as_closed() {
    let service = Service::default();
    let cache = service.cache();
    holds(&mut cache.observe(&key("a"))).await;
    cache.dispose();

    assert!(ended(&mut cache.observe(&key("a"))).await);
    cache.invalidate(&key("a"));
    cache.invalidate_all();
    cache.set(&key("a"), key("written"));
    cache.remove(&key("a"), refused("gone"));
    let refusal = cache.fetch(&key("a")).await.expect_err("it is closed");
    assert_eq!(refusal.code(), "bus.closed");
    settle().await;
    assert_eq!(service.asked(), 1);
    assert_eq!(cache.get(&key("a")), None);
    assert!(cache.keys().is_empty());
}

// ── B17, B18: persistence ───────────────────────────────────────────────

/// What a persister calls with what another context saved.
type Heard = Box<dyn Fn(HashMap<String, String>) + Send + Sync>;

/// A persister that keeps what it is given, and counts.
#[derive(Default)]
struct Kept {
    stored: Mutex<Option<HashMap<String, String>>>,
    saves: Mutex<Vec<HashMap<String, String>>>,
    external: Mutex<Option<Heard>>,
}

impl Kept {
    fn with(entries: &[(&str, &str)]) -> Arc<Kept> {
        Arc::new(Kept {
            stored: Mutex::new(Some(
                entries
                    .iter()
                    .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                    .collect(),
            )),
            ..Kept::default()
        })
    }

    fn saves(&self) -> Vec<HashMap<String, String>> {
        self.saves.lock().expect("saves").clone()
    }

    /// Another context saved these.
    fn externally(&self, entries: &[(&str, &str)]) {
        let entries = entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        if let Some(heard) = self.external.lock().expect("external").as_ref() {
            heard(entries);
        }
    }
}

impl CachePersister<String, String> for Kept {
    fn load(&self) -> Option<HashMap<String, String>> {
        self.stored.lock().expect("stored").clone()
    }

    fn save(&self, entries: &HashMap<String, String>) {
        self.saves.lock().expect("saves").push(entries.clone());
    }

    fn subscribe(
        &self,
        on_external_change: Box<dyn Fn(HashMap<String, String>) + Send + Sync>,
    ) -> Option<StorageSubscription> {
        *self.external.lock().expect("external") = Some(on_external_change);
        Some(StorageSubscription::new(|| {}))
    }
}

fn persisted(service: &Service, kept: &Arc<Kept>) -> Cache<String, String> {
    Cache::persisted(service.fetching(), kept.clone(), SAVE_DEBOUNCE)
}

#[tokio::test(start_paused = true)]
async fn b17_b18_a_kept_value_is_shown_at_once_and_asked_for_again_once() {
    let service = Service::default();
    let kept = Kept::with(&[("a", "from before"), ("b", "also kept")]);
    let cache = persisted(&service, &kept);
    assert_eq!(cache.get(&key("a")), Some(key("from before")));
    assert_eq!(service.asked(), 0);

    let answer = service.hold();
    let mut observer = cache.observe(&key("a"));
    // At once, and never pending.
    assert_eq!(next(&mut observer).await, Some(ready("from before")));
    settle().await;
    assert_eq!(service.asked(), 1);
    answer
        .send(Ok(key("as it is now")))
        .expect("the revalidation is waiting");
    assert_eq!(holds(&mut observer).await, ready("as it is now"));

    // Once: a later observer asks nothing, and a key nobody looks at is
    // never asked for.
    holds(&mut cache.observe(&key("a"))).await;
    assert_eq!(service.asked(), 1);
    assert_eq!(service.asked_for("b"), 0);
}

#[tokio::test(start_paused = true)]
async fn b18_a_kept_value_whose_revalidation_fails_is_still_shown() {
    let service = Service::default();
    service.then(Err(refused("down")));
    service.then(Err(refused("down")));
    let kept = Kept::with(&[("a", "from before")]);
    let cache = persisted(&service, &kept);
    let mut observer = cache.observe(&key("a"));
    assert_eq!(holds(&mut observer).await, ready("from before"));
    assert_eq!(service.asked(), 2);
}

#[tokio::test(start_paused = true)]
async fn b17_a_burst_of_changes_is_one_save_and_failures_are_never_saved() {
    let service = Service::default();
    let kept = Arc::new(Kept::default());
    let cache = persisted(&service, &kept);
    cache.set(&key("a"), key("one"));
    cache.set(&key("a"), key("two"));
    cache.set(&key("b"), key("three"));
    assert!(cache.persistence_pending());
    assert!(kept.saves().is_empty());

    tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
    assert!(!cache.persistence_pending());
    let expected: HashMap<String, String> =
        [(key("a"), key("two")), (key("b"), key("three"))].into();
    assert_eq!(kept.saves(), std::slice::from_ref(&expected));

    // A key that failed holds no value, so there is nothing of it to save.
    service.then(Err(refused("down")));
    service.then(Err(refused("down")));
    holds(&mut cache.observe(&key("failed"))).await;
    tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
    assert_eq!(kept.saves(), [expected]);
}

#[tokio::test(start_paused = true)]
async fn b17_disposal_makes_the_save_that_was_owed_and_nothing_is_saved_after() {
    let service = Service::default();
    let kept = Arc::new(Kept::default());
    let cache = persisted(&service, &kept);
    cache.set(&key("a"), key("last write"));
    cache.dispose();
    assert_eq!(kept.saves(), [[(key("a"), key("last write"))].into()]);

    cache.set(&key("a"), key("after"));
    tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
    assert_eq!(kept.saves().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn b17_what_another_context_saved_is_shown_and_not_saved_back() {
    let service = Service::default();
    let kept = Arc::new(Kept::default());
    let cache = persisted(&service, &kept);
    cache.set(&key("a"), key("mine"));
    let mut observer = cache.observe(&key("a"));
    assert_eq!(holds(&mut observer).await, ready("mine"));
    tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
    let saved = kept.saves().len();

    kept.externally(&[("a", "theirs")]);
    assert_eq!(next(&mut observer).await, Some(ready("theirs")));
    tokio::time::sleep(SAVE_DEBOUNCE * 4).await;
    assert_eq!(kept.saves().len(), saved, "an answer to a save is no save");
    assert_eq!(service.asked(), 0);
}

// ── The persister over a storage ────────────────────────────────────────

fn stored(
    storage: &Arc<InMemorySessionStorage>,
    version: u64,
    max_bytes: usize,
) -> StoragePersister<String, String> {
    StoragePersister::new(storage.clone(), "semiont.cache.kb.test", version, max_bytes)
}

fn entries(of: &[(&str, &str)]) -> HashMap<String, String> {
    of.iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

#[test]
fn a_stored_cache_is_one_document_and_is_read_back_as_it_was_written() {
    let storage = Arc::new(InMemorySessionStorage::new());
    let persister = stored(&storage, 1, MAX_STORED_BYTES);
    assert_eq!(persister.load(), None);
    persister.save(&entries(&[("a", "one"), ("b", "two")]));

    let document: Value =
        serde_json::from_str(&storage.get("semiont.cache.kb.test").expect("a document"))
            .expect("it is JSON");
    assert_eq!(document["version"], json!(1));
    assert_eq!(document["entries"].as_array().map(Vec::len), Some(2));

    assert_eq!(
        stored(&storage, 1, MAX_STORED_BYTES).load(),
        Some(entries(&[("a", "one"), ("b", "two")]))
    );
}

#[test]
fn a_document_of_another_version_or_one_that_is_not_a_document_reads_as_nothing_kept() {
    let storage = Arc::new(InMemorySessionStorage::new());
    stored(&storage, 1, MAX_STORED_BYTES).save(&entries(&[("a", "one")]));
    assert_eq!(stored(&storage, 2, MAX_STORED_BYTES).load(), None);

    storage.set("semiont.cache.kb.test", "{ not a document");
    assert_eq!(stored(&storage, 1, MAX_STORED_BYTES).load(), None);
    storage.set("semiont.cache.kb.test", "[1, 2, 3]");
    assert_eq!(stored(&storage, 1, MAX_STORED_BYTES).load(), None);
}

#[test]
fn a_document_over_its_size_loses_the_entries_longest_unwritten() {
    let storage = Arc::new(InMemorySessionStorage::new());
    let value = "x".repeat(100);
    let persister = stored(&storage, 1, 400);
    persister.save(&entries(&[("oldest", &value)]));
    std::thread::sleep(Duration::from_millis(5));
    persister.save(&entries(&[("oldest", &value), ("older", &value)]));
    std::thread::sleep(Duration::from_millis(5));
    // An entry whose value did not change keeps the time it was written, so
    // the newest is the one that stays.
    persister.save(&entries(&[
        ("oldest", &value),
        ("older", &value),
        ("newest", &value),
    ]));

    let kept = stored(&storage, 1, 400).load().expect("a document");
    assert!(kept.contains_key("newest"), "{kept:?}");
    assert!(!kept.contains_key("oldest"), "{kept:?}");
    assert!(
        storage
            .get("semiont.cache.kb.test")
            .expect("a document")
            .len()
            <= 400
    );
}

/// A storage another context writes to.
#[derive(Default)]
struct Shared {
    inner: InMemorySessionStorage,
    heard: Mutex<Option<StorageChange>>,
}

impl Shared {
    fn written_elsewhere(&self, key: &str, value: &str) {
        self.inner.set(key, value);
        if let Some(heard) = self.heard.lock().expect("heard").as_ref() {
            heard(key, Some(value));
        }
    }
}

impl SessionStorage for Shared {
    fn get(&self, key: &str) -> Option<String> {
        self.inner.get(key)
    }

    fn set(&self, key: &str, value: &str) {
        self.inner.set(key, value);
    }

    fn delete(&self, key: &str) {
        self.inner.delete(key);
    }

    fn subscribe(&self, on_change: StorageChange) -> Option<StorageSubscription> {
        *self.heard.lock().expect("heard") = Some(on_change);
        Some(StorageSubscription::new(|| {}))
    }
}

#[test]
fn what_another_context_writes_under_the_caches_key_is_heard_and_under_another_key_is_not() {
    let storage = Arc::new(Shared::default());
    let persister: StoragePersister<String, String> = StoragePersister::new(
        storage.clone(),
        "semiont.cache.kb.test",
        1,
        MAX_STORED_BYTES,
    );
    let heard: Arc<Mutex<Vec<HashMap<String, String>>>> = Arc::default();
    let hearing = heard.clone();
    let _subscription = persister
        .subscribe(Box::new(move |entries| {
            hearing.lock().expect("heard").push(entries);
        }))
        .expect("this storage has other contexts");

    let theirs = r#"{"version":1,"writtenAt":5,"entries":[["a","theirs",5]]}"#;
    storage.written_elsewhere("another.key", theirs);
    storage.written_elsewhere("semiont.cache.kb.test", theirs);
    storage.written_elsewhere(
        "semiont.cache.kb.test",
        r#"{"version":9,"writtenAt":5,"entries":[]}"#,
    );
    assert_eq!(*heard.lock().expect("heard"), [entries(&[("a", "theirs")])]);
}

// ── The cache as a state unit ───────────────────────────────────────────

struct Caches;

impl AxiomSubject for Caches {
    type Unit = Cache<String, String>;

    fn setup(&self) -> Fresh<Cache<String, String>> {
        Fresh::of(Service::default().cache())
    }

    fn surfaces(&self, cache: &Cache<String, String>) -> Vec<Box<dyn Surface>> {
        vec![
            Box::new(StreamSurface(cache.observe(&"a".to_owned()))),
            Box::new(StreamSurface(cache.observe(&"b".to_owned()))),
        ]
    }

    fn invocations<'a>(&self, cache: &'a Cache<String, String>) -> Vec<Box<dyn Fn() + 'a>> {
        let a = || "a".to_owned();
        vec![
            Box::new(move || cache.invalidate(&a())),
            Box::new(move || cache.invalidate_all()),
            Box::new(move || cache.set(&a(), "written".to_owned())),
            Box::new(move || cache.remove(&a(), refused("gone"))),
            Box::new(move || drop(tokio::spawn(cache.fetch(&a())))),
        ]
    }
}

#[test]
fn the_cache_keeps_the_state_unit_axioms() {
    assert_eq!(assert_state_unit_axioms(&Caches), Ok(()));
}
