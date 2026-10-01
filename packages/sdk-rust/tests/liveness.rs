//! The liveness harness against compositions that keep its axioms and ones
//! built to break each: an axiom nothing can fail holds nothing.

use proptest::prelude::Just;
use proptest::strategy::Strategy;
use semiont::bus::{Bus, Operation, operation};
use semiont::testing::liveness::{
    DeliveryOp, DeliverySubject, LivenessScenario, LivenessSpec, Respond,
    assert_exactly_once_delivery, assert_liveness_axioms,
};
use semiont::testing::{FaultAction, FaultyTransport};
use semiont::transport::{BoxFuture, Envelope, Transport};
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_millis(200);

fn read() -> &'static Operation {
    operation("browse:resource-requested").expect("a registry operation")
}

fn asking() -> Map<String, Value> {
    json!({ "resourceId": "r1" })
        .as_object()
        .cloned()
        .expect("an object")
}

fn answering() -> Option<Arc<Respond>> {
    Some(Arc::new(|_, _| Ok(None)))
}

fn spec<Setup>(setup: Setup, schedule: Option<Vec<FaultAction>>) -> LivenessSpec<Setup> {
    LivenessSpec {
        setup,
        timeout: TIMEOUT,
        retry_budget: 1,
        schedules: schedule.map(|schedule| Just(schedule).boxed()),
        respond: answering(),
        cases: 25,
    }
}

#[test]
fn a_request_settles_under_every_schedule() {
    let outcome = assert_liveness_axioms(spec(
        |transport: FaultyTransport| {
            let bus = Bus::new(Arc::new(transport));
            LivenessScenario {
                outputs: Vec::new(),
                settlements: vec![Box::pin(async move {
                    let _ = bus.request_of(read(), asking(), TIMEOUT).await;
                })],
            }
        },
        None,
    ));
    assert_eq!(outcome, Ok(()));
}

#[test]
fn a_wait_with_no_deadline_breaks_l2() {
    let violation = assert_liveness_axioms(spec(
        |transport: FaultyTransport| LivenessScenario {
            outputs: Vec::new(),
            settlements: vec![Box::pin(async move {
                let mut pending = transport.track_reply("cid", &[read().result, read().failure]);
                let envelope = Envelope {
                    correlation_id: Some("cid".to_owned()),
                    scope: None,
                };
                let _ = transport.emit(read().request, asking(), envelope).await;
                pending.frame().await;
            })],
        },
        Some(vec![FaultAction::DropReply]),
    ))
    .expect_err("a request that never settles must be caught");
    assert!(
        violation.contains("L2: settlement #0 did not settle"),
        "{violation}"
    );
}

#[test]
fn a_request_sent_again_past_its_budget_breaks_l2() {
    let violation = assert_liveness_axioms(spec(
        |transport: FaultyTransport| {
            let bus = Bus::new(Arc::new(transport));
            LivenessScenario {
                outputs: Vec::new(),
                settlements: vec![Box::pin(async move {
                    for _ in 0..3 {
                        if bus.request_of(read(), asking(), TIMEOUT).await.is_ok() {
                            return;
                        }
                    }
                })],
            }
        },
        Some(vec![FaultAction::RejectEmit]),
    ))
    .expect_err("a request sent three times on a budget of one retry must be caught");
    assert!(violation.contains("past the retry budget"), "{violation}");
}

#[test]
fn a_swallowed_failure_breaks_l2() {
    let violation = assert_liveness_axioms(spec(
        |transport: FaultyTransport| {
            let bus = Bus::new(Arc::new(transport));
            let (said, output) = tokio::sync::oneshot::channel::<()>();
            tokio::spawn(async move {
                // The failure goes nowhere: the output is told only of success.
                if bus.request_of(read(), asking(), TIMEOUT).await.is_ok() {
                    let _ = said.send(());
                } else {
                    std::future::pending::<()>().await;
                    drop(said);
                }
            });
            LivenessScenario {
                outputs: vec![Box::pin(async move {
                    let _ = output.await;
                })],
                settlements: Vec::new(),
            }
        },
        Some(vec![FaultAction::RejectEmit]),
    ))
    .expect_err("a failure nothing surfaces must be caught");
    assert!(
        violation.contains("its failure was swallowed"),
        "{violation}"
    );
}

#[test]
fn an_output_that_says_nothing_breaks_l1() {
    let violation = assert_liveness_axioms(spec(
        |_transport: FaultyTransport| LivenessScenario {
            outputs: vec![Box::pin(std::future::pending())],
            settlements: Vec::new(),
        },
        Some(vec![FaultAction::Deliver]),
    ))
    .expect_err("a silent output must be caught");
    assert!(
        violation.contains("L1: output #0 said nothing"),
        "{violation}"
    );
}

/// How a connection is retired when the client moves to another.
#[derive(Clone, Copy)]
enum Retire {
    /// What it had received and not delivered is delivered first.
    Drain,
    /// It is dropped with whatever it had received.
    Abort,
    /// It is drained, and the next connection replays the same events.
    DrainAndReplay,
}

struct Connections {
    retire: Retire,
    received: Mutex<Vec<String>>,
    delivered: Mutex<Vec<String>>,
}

impl DeliverySubject for Connections {
    fn write(&self, event_id: &str) {
        self.received.lock().unwrap().push(event_id.to_owned());
    }

    fn transition(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let mut received = self.received.lock().unwrap();
            match self.retire {
                Retire::Drain => self.delivered.lock().unwrap().append(&mut received),
                Retire::Abort => received.clear(),
                Retire::DrainAndReplay => self
                    .delivered
                    .lock()
                    .unwrap()
                    .extend(received.iter().cloned()),
            }
        })
    }

    fn delivered(&self) -> BoxFuture<'_, Vec<String>> {
        Box::pin(async move {
            let mut delivered = self.delivered.lock().unwrap();
            delivered.append(&mut self.received.lock().unwrap());
            delivered.clone()
        })
    }
}

fn delivery(retire: Retire) -> Result<(), String> {
    assert_exactly_once_delivery(
        || async move {
            Connections {
                retire,
                received: Mutex::new(Vec::new()),
                delivered: Mutex::new(Vec::new()),
            }
        },
        Some(
            Just(vec![
                DeliveryOp::Write,
                DeliveryOp::Transition,
                DeliveryOp::Write,
            ])
            .boxed(),
        ),
        10,
    )
}

#[test]
fn a_connection_retired_by_drain_delivers_once() {
    assert_eq!(delivery(Retire::Drain), Ok(()));
}

#[test]
fn a_connection_retired_by_abort_breaks_l3() {
    let violation = delivery(Retire::Abort).expect_err("a lost event must be caught");
    assert!(violation.contains("delivered 0 times"), "{violation}");
}

#[test]
fn an_event_delivered_by_both_connections_breaks_l3() {
    let violation = delivery(Retire::DrainAndReplay).expect_err("a doubled event must be caught");
    assert!(violation.contains("delivered 2 times"), "{violation}");
}
