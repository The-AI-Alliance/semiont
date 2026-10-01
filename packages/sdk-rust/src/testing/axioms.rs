//! The state-unit axioms, executable: `assert_state_unit_axioms` runs each
//! against a unit and fails, naming the axiom, on the first one it breaks.
//! One call per state unit, from that unit's tests.
//!
//! - **A5** `dispose` is idempotent and total: any number of calls, none
//!   panics, and none disposes what the unit was given.
//! - **A5b** the unit is inert after `dispose`: its methods do nothing, and a
//!   surface taken afterwards has already ended.
//! - **A6** every reader of a surface taken before `dispose` sees it end.
//! - **A7-passed** disposing the unit does not dispose a dependency it was
//!   given: a `DisposeProbe` standing in for one, or the client itself.
//! - **A7-owned** disposing the unit ends the surfaces of the children it
//!   made.
//! - **X3** instances are isolated: driving one never moves another's
//!   surfaces.
//!
//! Each run happens on a runtime of its own with time paused, so a unit that
//! spawns tasks or keeps timers is given the chance to act on what the
//! harness did before the harness looks.

use crate::client::SemiontClient;
use crate::state_unit::StateUnit;
use futures_core::Stream;
use proptest::collection::vec;
use proptest::strategy::Strategy;
use proptest::test_runner::{Config, TestCaseError, TestRunner};
use std::fmt::Debug;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll, Waker};
use std::time::Duration;
use tokio::sync::{broadcast, watch};

/// A surface of a state unit as the axioms watch it: one reader's view of a
/// state or an event stream.
pub trait Surface {
    /// Whether it has ended: nothing more will come.
    fn ended(&mut self) -> bool;
    /// Whether anything came since this was last asked.
    fn moved(&mut self) -> bool;
}

impl<T> Surface for watch::Receiver<T> {
    fn ended(&mut self) -> bool {
        self.has_changed().is_err()
    }

    fn moved(&mut self) -> bool {
        let moved = matches!(self.has_changed(), Ok(true));
        if moved {
            self.borrow_and_update();
        }
        moved
    }
}

impl<T: Clone> Surface for broadcast::Receiver<T> {
    fn ended(&mut self) -> bool {
        loop {
            match self.try_recv() {
                Err(broadcast::error::TryRecvError::Closed) => return true,
                Err(broadcast::error::TryRecvError::Empty) => return false,
                Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) => {}
            }
        }
    }

    fn moved(&mut self) -> bool {
        let mut moved = false;
        while matches!(
            self.try_recv(),
            Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_))
        ) {
            moved = true;
        }
        moved
    }
}

/// Any stream as a surface: it has moved when it has an item ready, and
/// ended when it has ended.
pub struct StreamSurface<S>(pub S);

impl<S: Stream + Unpin> StreamSurface<S> {
    fn poll(&mut self) -> Poll<Option<S::Item>> {
        Pin::new(&mut self.0).poll_next(&mut Context::from_waker(Waker::noop()))
    }
}

impl<S: Stream + Unpin> Surface for StreamSurface<S> {
    fn ended(&mut self) -> bool {
        loop {
            match self.poll() {
                Poll::Ready(None) => return true,
                Poll::Pending => return false,
                Poll::Ready(Some(_)) => {}
            }
        }
    }

    fn moved(&mut self) -> bool {
        let mut moved = false;
        while let Poll::Ready(Some(_)) = self.poll() {
            moved = true;
        }
        moved
    }
}

/// A dependency a unit was given, as the axioms watch it.
pub trait Given {
    /// Whether anything has disposed it.
    fn disposed(&self) -> bool;
}

/// A client is disposed when it is closed, and closing it ends its own bus.
impl Given for Arc<SemiontClient> {
    fn disposed(&self) -> bool {
        self.bus().destroyed()
    }
}

/// A stand-in for a dependency a unit is given. Pass one to the unit, list it
/// in `Fresh::passed_in`, and the axioms check the unit never disposed it.
#[derive(Clone, Default)]
pub struct DisposeProbe {
    disposals: Arc<AtomicUsize>,
}

impl DisposeProbe {
    pub fn new() -> DisposeProbe {
        DisposeProbe::default()
    }

    pub fn dispose_count(&self) -> usize {
        self.disposals.load(Ordering::SeqCst)
    }
}

impl StateUnit for DisposeProbe {
    fn dispose(&self) {
        self.disposals.fetch_add(1, Ordering::SeqCst);
    }
}

impl Given for DisposeProbe {
    fn disposed(&self) -> bool {
        self.dispose_count() > 0
    }
}

/// A freshly built unit, and what it was built with.
pub struct Fresh<U> {
    pub unit: U,
    /// What it was given as dependencies.
    pub passed_in: Vec<Box<dyn Given>>,
}

impl<U> Fresh<U> {
    pub fn of(unit: U) -> Fresh<U> {
        Fresh {
            unit,
            passed_in: Vec::new(),
        }
    }

    /// The same, with one more dependency the unit was given.
    pub fn given(mut self, dependency: impl Given + 'static) -> Fresh<U> {
        self.passed_in.push(Box::new(dependency));
        self
    }
}

/// How the axioms reach one kind of state unit. Only `setup` is required: an
/// accessor left at its default skips the axioms that need it.
pub trait AxiomSubject {
    type Unit: StateUnit;

    /// Build a fresh unit, independent of every other one.
    fn setup(&self) -> Fresh<Self::Unit>;

    /// A new reader of each surface the unit owns.
    fn surfaces(&self, _unit: &Self::Unit) -> Vec<Box<dyn Surface>> {
        Vec::new()
    }

    /// Each of the unit's methods, as a call with no arguments.
    fn invocations<'a>(&self, _unit: &'a Self::Unit) -> Vec<Box<dyn Fn() + 'a>> {
        Vec::new()
    }

    /// A new reader of each surface of the children the unit made itself.
    fn owned_child_surfaces(&self, _unit: &Self::Unit) -> Vec<Box<dyn Surface>> {
        Vec::new()
    }
}

const CASES: u32 = 30;

/// Let whatever the unit spawned act on what just happened.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

fn property<T: Debug>(
    axiom: &str,
    values: impl Strategy<Value = T>,
    check: impl Fn(T) -> Result<(), String>,
) -> Result<(), String> {
    let mut runner = TestRunner::new(Config {
        cases: CASES,
        failure_persistence: None,
        ..Config::default()
    });
    runner
        .run(&values, |value| {
            match catch_unwind(AssertUnwindSafe(|| check(value))) {
                Ok(Ok(())) => Ok(()),
                Ok(Err(violation)) => Err(TestCaseError::fail(violation)),
                Err(_) => Err(TestCaseError::fail("the unit panicked")),
            }
        })
        .map_err(|failure| format!("{axiom}: {failure}"))
}

/// Run every axiom the subject gives the means to check. `Err` names the
/// first axiom broken and how.
pub fn assert_state_unit_axioms<S: AxiomSubject>(subject: &S) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .start_paused(true)
        .build()
        .map_err(|e| format!("cannot build a runtime for the axioms: {e}"))?;
    let undisposed = |fresh: &Fresh<S::Unit>, when: &str| -> Result<(), String> {
        match fresh.passed_in.iter().position(|given| given.disposed()) {
            Some(i) => Err(format!(
                "the unit disposed dependency #{i} it was given {when}"
            )),
            None => Ok(()),
        }
    };

    // A7-passed
    runtime
        .block_on(async {
            let fresh = subject.setup();
            fresh.unit.dispose();
            settle().await;
            undisposed(&fresh, "(it does not own it)")
        })
        .map_err(|violation| format!("A7-passed: {violation}"))?;

    // A5
    property("A5", 1usize..=20, |n| {
        runtime.block_on(async {
            let fresh = subject.setup();
            for _ in 0..n {
                fresh.unit.dispose();
            }
            settle().await;
            undisposed(&fresh, &format!("under {n} dispose() calls"))
        })
    })?;

    // A6
    if !runtime.block_on(async { subject.surfaces(&subject.setup().unit).is_empty() }) {
        property("A6", 1usize..=10, |k| {
            runtime.block_on(async {
                let fresh = subject.setup();
                let mut readers: Vec<Box<dyn Surface>> =
                    (0..k).flat_map(|_| subject.surfaces(&fresh.unit)).collect();
                fresh.unit.dispose();
                settle().await;
                match readers.iter_mut().position(|reader| !reader.ended()) {
                    Some(i) => Err(format!(
                        "reader #{i} of a surface did not see it end on dispose (k={k})"
                    )),
                    None => Ok(()),
                }
            })
        })?;
    }

    // A5b
    property("A5b", vec(0usize..1000, 0..=12), |calls| {
        runtime.block_on(async {
            let fresh = subject.setup();
            fresh.unit.dispose();
            {
                let invocations = subject.invocations(&fresh.unit);
                for call in &calls {
                    if invocations.is_empty() {
                        break;
                    }
                    invocations[call % invocations.len()]();
                }
            }
            settle().await;
            for (i, surface) in subject.surfaces(&fresh.unit).iter_mut().enumerate() {
                if surface.moved() {
                    return Err(format!("surface #{i} gave a value after dispose"));
                }
                if !surface.ended() {
                    return Err(format!("surface #{i}, taken after dispose, has not ended"));
                }
            }
            Ok(())
        })
    })?;

    // X3
    property("X3", vec(0usize..1000, 1..=8), |calls| {
        runtime.block_on(async {
            let a = subject.setup();
            let b = subject.setup();
            let mut watched = subject.surfaces(&b.unit);
            settle().await;
            for surface in watched.iter_mut() {
                surface.moved();
            }
            {
                let invocations = subject.invocations(&a.unit);
                for call in &calls {
                    if invocations.is_empty() {
                        break;
                    }
                    invocations[call % invocations.len()]();
                }
            }
            settle().await;
            let perturbed = watched.iter_mut().position(|surface| surface.moved());
            a.unit.dispose();
            b.unit.dispose();
            settle().await;
            match perturbed {
                Some(i) => Err(format!(
                    "driving one instance moved surface #{i} of another"
                )),
                None => Ok(()),
            }
        })
    })?;

    // A7-owned
    runtime
        .block_on(async {
            let fresh = subject.setup();
            let mut children = subject.owned_child_surfaces(&fresh.unit);
            fresh.unit.dispose();
            settle().await;
            match children.iter_mut().position(|child| !child.ended()) {
                Some(i) => Err(format!(
                    "the surface #{i} of a child the unit made did not end when the unit was disposed"
                )),
                None => Ok(()),
            }
        })
        .map_err(|violation| format!("A7-owned: {violation}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::ClientOptions;
    use crate::testing::{FaultyTransport, InMemoryContent};
    use std::sync::Mutex;

    type Value = Arc<Mutex<Option<watch::Sender<u32>>>>;

    /// The ways a counter can break the axioms, one switch each.
    #[derive(Clone, Copy, Default)]
    struct Faults {
        dispose_panics_twice: bool,
        keeps_its_sender: bool,
        revives_after_dispose: bool,
        disposes_what_it_was_given: bool,
        increments_every_instance: bool,
        keeps_its_child: bool,
    }

    /// A counter: one state, one method, one dependency it was given and one
    /// child it made.
    struct Counter {
        faults: Faults,
        value: Value,
        reader: Mutex<watch::Receiver<u32>>,
        /// Every counter its subject built, itself among them.
        instances: Arc<Mutex<Vec<Value>>>,
        given: DisposeProbe,
        child: Mutex<Option<watch::Sender<u32>>>,
        child_reader: watch::Receiver<u32>,
        disposals: AtomicUsize,
    }

    impl Counter {
        fn new(faults: Faults, given: DisposeProbe, instances: Arc<Mutex<Vec<Value>>>) -> Counter {
            let (value, reader) = watch::channel(0);
            let value: Value = Arc::new(Mutex::new(Some(value)));
            instances.lock().unwrap().push(value.clone());
            let (child, child_reader) = watch::channel(0);
            Counter {
                faults,
                value,
                reader: Mutex::new(reader),
                instances,
                given,
                child: Mutex::new(Some(child)),
                child_reader,
                disposals: AtomicUsize::new(0),
            }
        }

        fn increment(&self) {
            let bump = |value: &Value| {
                if let Some(value) = value.lock().unwrap().as_ref() {
                    value.send_modify(|n| *n += 1);
                }
            };
            if self.faults.increments_every_instance {
                self.instances.lock().unwrap().iter().for_each(bump);
            } else {
                bump(&self.value);
            }
        }
    }

    impl StateUnit for Counter {
        fn dispose(&self) {
            if self.disposals.fetch_add(1, Ordering::SeqCst) == 1
                && self.faults.dispose_panics_twice
            {
                panic!("disposed twice");
            }
            if self.faults.disposes_what_it_was_given {
                self.given.dispose();
            }
            if self.faults.revives_after_dispose {
                let (value, reader) = watch::channel(0);
                *self.value.lock().unwrap() = Some(value);
                *self.reader.lock().unwrap() = reader;
            } else if !self.faults.keeps_its_sender {
                *self.value.lock().unwrap() = None;
            }
            if !self.faults.keeps_its_child {
                *self.child.lock().unwrap() = None;
            }
        }
    }

    struct Counters {
        faults: Faults,
        instances: Arc<Mutex<Vec<Value>>>,
    }

    impl AxiomSubject for Counters {
        type Unit = Counter;

        fn setup(&self) -> Fresh<Counter> {
            let given = DisposeProbe::new();
            Fresh::of(Counter::new(
                self.faults,
                given.clone(),
                self.instances.clone(),
            ))
            .given(given)
        }

        fn surfaces(&self, unit: &Counter) -> Vec<Box<dyn Surface>> {
            vec![Box::new(unit.reader.lock().unwrap().clone())]
        }

        fn invocations<'a>(&self, unit: &'a Counter) -> Vec<Box<dyn Fn() + 'a>> {
            vec![Box::new(|| unit.increment())]
        }

        fn owned_child_surfaces(&self, unit: &Counter) -> Vec<Box<dyn Surface>> {
            vec![Box::new(unit.child_reader.clone())]
        }
    }

    fn check(faults: Faults) -> Result<(), String> {
        assert_state_unit_axioms(&Counters {
            faults,
            instances: Arc::new(Mutex::new(Vec::new())),
        })
    }

    fn broken(faults: Faults) -> String {
        check(faults).expect_err("the fault must be caught")
    }

    #[test]
    fn a_unit_that_keeps_the_axioms_passes() {
        assert_eq!(check(Faults::default()), Ok(()));
    }

    #[test]
    fn a_dispose_that_is_not_idempotent_breaks_a5() {
        let violation = broken(Faults {
            dispose_panics_twice: true,
            ..Faults::default()
        });
        assert!(violation.starts_with("A5:"), "{violation}");
    }

    #[test]
    fn a_sender_left_open_breaks_a6() {
        let violation = broken(Faults {
            keeps_its_sender: true,
            ..Faults::default()
        });
        assert!(violation.starts_with("A6:"), "{violation}");
    }

    #[test]
    fn a_unit_that_acts_after_dispose_breaks_a5b() {
        let violation = broken(Faults {
            revives_after_dispose: true,
            ..Faults::default()
        });
        assert!(violation.starts_with("A5b:"), "{violation}");
    }

    #[test]
    fn a_unit_that_disposes_what_it_was_given_breaks_a7_passed() {
        let violation = broken(Faults {
            disposes_what_it_was_given: true,
            ..Faults::default()
        });
        assert!(violation.starts_with("A7-passed:"), "{violation}");
    }

    /// A unit over a client, which it closes when it is disposed.
    struct ClosesItsClient(Arc<SemiontClient>);

    impl StateUnit for ClosesItsClient {
        fn dispose(&self) {
            self.0.bus().destroy();
        }
    }

    struct ClientClosers;

    impl AxiomSubject for ClientClosers {
        type Unit = ClosesItsClient;

        fn setup(&self) -> Fresh<ClosesItsClient> {
            let client = Arc::new(SemiontClient::new(
                Arc::new(FaultyTransport::new(vec![])),
                Arc::new(InMemoryContent::new()),
                None,
                ClientOptions::default(),
            ));
            Fresh::of(ClosesItsClient(client.clone())).given(client)
        }
    }

    #[test]
    fn a_unit_that_closes_the_client_it_was_given_breaks_a7_passed() {
        let violation =
            assert_state_unit_axioms(&ClientClosers).expect_err("the fault must be caught");
        assert!(violation.starts_with("A7-passed:"), "{violation}");
    }

    #[test]
    fn a_child_left_alive_breaks_a7_owned() {
        let violation = broken(Faults {
            keeps_its_child: true,
            ..Faults::default()
        });
        assert!(violation.starts_with("A7-owned:"), "{violation}");
    }

    #[test]
    fn state_shared_between_instances_breaks_x3() {
        let violation = broken(Faults {
            increments_every_instance: true,
            ..Faults::default()
        });
        assert!(violation.starts_with("X3:"), "{violation}");
    }
}
