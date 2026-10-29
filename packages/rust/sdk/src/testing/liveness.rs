//! The liveness axioms, executable. The state-unit axioms make a unit's
//! wrongness detectable; these make silence detectable: under any behaviour
//! of the wire, something is eventually delivered.
//!
//! - **L1** every output says something, a value or a failure, within the
//!   bound. Pending forever is the violation.
//! - **L2** every awaited path settles within the bound; a request is sent
//!   again no more often than its retry budget allows; and one whose last
//!   attempt was faulted is either sent again or surfaced, never swallowed.
//! - **L3** every event written to a live connection is delivered exactly
//!   once, wherever a client-initiated transition (a handoff, a reopening, a
//!   change of scope) lands relative to it: a connection is retired by
//!   drain, never by abort.
//!
//! L1 and L2 run a composition against a `FaultyTransport` over generated
//! fault schedules, with time paused, so a bound of seconds costs nothing. L3
//! runs generated interleavings of writes and transitions against anything
//! shaped like a connection: a model, with time paused, or a real transport
//! over real sockets, on a runtime its caller gives.

use super::faulty_transport::{FaultAction, FaultyTransport};
use crate::transport::{BoxFuture, Transport};
use proptest::collection::vec;
use proptest::prelude::{Just, prop_oneof};
use proptest::strategy::{BoxedStrategy, Strategy};
use proptest::test_runner::{Config, TestCaseError, TestRunner};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .start_paused(true)
        .build()
        .map_err(|e| format!("cannot build a runtime for the axioms: {e}"))
}

// ── L1, L2 ──────────────────────────────────────────────────────────────

/// What one fresh run of a composition exposes to the axioms.
#[derive(Default)]
pub struct LivenessScenario {
    /// One per output: resolves when the output has said something, a value
    /// or a failure (L1).
    pub outputs: Vec<BoxFuture<'static, ()>>,
    /// One per awaited path: resolves when it has settled, either way (L2).
    pub settlements: Vec<BoxFuture<'static, ()>>,
}

/// The gateway's answer to a request no queued response answers.
pub type Respond = dyn Fn(&str, &Map<String, Value>) -> Result<Option<Value>, String> + Send + Sync;

pub struct LivenessSpec<Setup> {
    /// Build a fresh composition over the transport it is given. Called once
    /// per run, inside the run's runtime.
    pub setup: Setup,
    /// The time the composition gives a bus request. The bound is derived
    /// from it: (timeout × (1 + retry budget) + the schedule's delays) × 4.
    pub timeout: Duration,
    /// How often a logical request may be sent again.
    pub retry_budget: usize,
    /// The schedules to run; `None` generates them.
    pub schedules: Option<BoxedStrategy<Vec<FaultAction>>>,
    /// What the gateway answers; `None` refuses whatever nothing queued an
    /// answer for.
    pub respond: Option<Arc<Respond>>,
    pub cases: u32,
}

/// A wire behaviour, each as likely as the others; delays stay small.
pub fn fault_actions() -> impl Strategy<Value = FaultAction> {
    prop_oneof![
        Just(FaultAction::Deliver),
        Just(FaultAction::DropReply),
        (0u64..=5).prop_map(|ms| FaultAction::Delay(Duration::from_millis(ms))),
        Just(FaultAction::DuplicateReply),
        Just(FaultAction::RejectEmit),
    ]
}

/// A fault schedule of one to eight behaviours.
pub fn fault_schedules() -> impl Strategy<Value = Vec<FaultAction>> {
    vec(fault_actions(), 1..=8)
}

fn described(schedule: &[FaultAction]) -> String {
    schedule
        .iter()
        .map(|action| match action {
            FaultAction::Deliver => "deliver".to_owned(),
            FaultAction::DropReply => "drop-reply".to_owned(),
            FaultAction::Delay(after) => format!("delay({})", after.as_millis()),
            FaultAction::DuplicateReply => "duplicate-reply".to_owned(),
            FaultAction::RejectEmit => "reject-emit".to_owned(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Run L1 and L2 across fault schedules. `Err` names the axiom broken, how,
/// and under which schedule.
pub fn assert_liveness_axioms<Setup>(spec: LivenessSpec<Setup>) -> Result<(), String>
where
    Setup: Fn(FaultyTransport) -> LivenessScenario,
{
    let runtime = runtime()?;
    let schedules = spec
        .schedules
        .clone()
        .unwrap_or_else(|| fault_schedules().boxed());
    let mut runner = TestRunner::new(Config {
        cases: spec.cases,
        failure_persistence: None,
        ..Config::default()
    });
    runner
        .run(&schedules, |schedule| {
            let delays: Duration = schedule
                .iter()
                .map(|action| match action {
                    FaultAction::Delay(after) => *after,
                    _ => Duration::ZERO,
                })
                .sum();
            let bound = (spec.timeout * (1 + spec.retry_budget as u32) + delays) * 4;
            runtime
                .block_on(async {
                    let transport = match &spec.respond {
                        Some(respond) => {
                            let respond = respond.clone();
                            FaultyTransport::answering(schedule.clone(), move |operation, payload| {
                                respond(operation, payload)
                            })
                        }
                        None => FaultyTransport::new(schedule.clone()),
                    };
                    let scenario = (spec.setup)(transport.clone());
                    let watch = |paths: Vec<BoxFuture<'static, ()>>| -> Vec<Arc<AtomicBool>> {
                        paths
                            .into_iter()
                            .map(|path| {
                                let done = Arc::new(AtomicBool::new(false));
                                let seen = done.clone();
                                tokio::spawn(async move {
                                    path.await;
                                    seen.store(true, Ordering::SeqCst);
                                });
                                done
                            })
                            .collect()
                    };
                    let notified = watch(scenario.outputs);
                    let settled = watch(scenario.settlements);
                    tokio::time::sleep(bound).await;

                    let under = format!("under schedule ⟨{}⟩", described(&schedule));
                    // L2 first: where it applies it names the mechanism. L1
                    // is the broader net, and would shadow it.
                    if let Some(i) = settled.iter().position(|s| !s.load(Ordering::SeqCst)) {
                        return Err(format!(
                            "L2: settlement #{i} did not settle within {}ms {under}",
                            bound.as_millis()
                        ));
                    }
                    let mut issued: HashMap<String, (usize, bool)> = HashMap::new();
                    for entry in transport.request_log() {
                        let faulted = matches!(
                            entry.action,
                            FaultAction::DropReply | FaultAction::RejectEmit
                        );
                        let issue = issued.entry(entry.retry_key).or_insert((0, false));
                        *issue = (issue.0 + 1, faulted);
                    }
                    let silent = !notified.iter().any(|n| n.load(Ordering::SeqCst));
                    for (key, (count, last_faulted)) in &issued {
                        if *count > 1 + spec.retry_budget {
                            return Err(format!(
                                "L2: request ⟨{key}⟩ was sent {count} times, past the retry budget (1 + {}) {under}",
                                spec.retry_budget
                            ));
                        }
                        if *last_faulted
                            && *count <= spec.retry_budget
                            && !notified.is_empty()
                            && silent
                        {
                            return Err(format!(
                                "L2: faulted request ⟨{key}⟩ was neither sent again nor surfaced {under}: its failure was swallowed"
                            ));
                        }
                    }
                    if let Some(i) = notified.iter().position(|n| !n.load(Ordering::SeqCst)) {
                        return Err(format!(
                            "L1: output #{i} said nothing within {}ms {under}: silently pending",
                            bound.as_millis()
                        ));
                    }
                    transport.close().await;
                    Ok(())
                })
                .map_err(TestCaseError::fail)
        })
        .map_err(|failure| failure.to_string())
}

// ── L3 ──────────────────────────────────────────────────────────────────

/// Something shaped like a connection: it accepts writes to whichever
/// connection is live, can be told to change connections, and delivers.
pub trait DeliverySubject {
    /// Write the event with this id to the connection that is live now.
    fn write(&self, event_id: &str);
    /// A client-initiated transition: a handoff, a reopening, a change of
    /// scope.
    fn transition(&self) -> BoxFuture<'_, ()>;
    /// Let whatever is in flight be delivered, then give the ids delivered,
    /// in order.
    fn delivered(&self) -> BoxFuture<'_, Vec<String>>;
}

/// One step of an interleaving.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryOp {
    Write,
    Transition,
}

/// Interleavings of writes and transitions, each with at least one write: a
/// sequence that writes nothing checks nothing.
pub fn delivery_ops(longest: usize) -> impl Strategy<Value = Vec<DeliveryOp>> {
    vec(
        prop_oneof![Just(DeliveryOp::Write), Just(DeliveryOp::Transition)],
        1..=longest,
    )
    .prop_map(|mut ops| {
        if !ops.contains(&DeliveryOp::Write) {
            ops.push(DeliveryOp::Write);
        }
        ops
    })
}

/// Run L3 across interleavings, with time paused: `setup` builds a fresh
/// subject for each, in the run's runtime. `Err` names the event lost or
/// doubled, and the interleaving.
pub fn assert_exactly_once_delivery<S, Building>(
    setup: impl Fn() -> Building,
    ops: Option<BoxedStrategy<Vec<DeliveryOp>>>,
    cases: u32,
) -> Result<(), String>
where
    S: DeliverySubject,
    Building: Future<Output = S>,
{
    assert_exactly_once_delivery_on(&runtime()?, setup, ops, cases)
}

/// The same, on `runtime`: for a subject that does real I/O, which paused
/// time cannot wait for.
pub fn assert_exactly_once_delivery_on<S, Building>(
    runtime: &tokio::runtime::Runtime,
    setup: impl Fn() -> Building,
    ops: Option<BoxedStrategy<Vec<DeliveryOp>>>,
    cases: u32,
) -> Result<(), String>
where
    S: DeliverySubject,
    Building: Future<Output = S>,
{
    let ops = ops.unwrap_or_else(|| delivery_ops(12).boxed());
    let mut runner = TestRunner::new(Config {
        cases,
        failure_persistence: None,
        ..Config::default()
    });
    runner
        .run(&ops, |ops| {
            runtime
                .block_on(async {
                    let subject = setup().await;
                    let mut written = Vec::new();
                    // No settling between steps: the races that matter are a
                    // transition landing before a write has been delivered.
                    for (i, op) in ops.iter().enumerate() {
                        match op {
                            DeliveryOp::Write => {
                                let id = format!("e{i}");
                                subject.write(&id);
                                written.push(id);
                            }
                            DeliveryOp::Transition => subject.transition().await,
                        }
                    }
                    let delivered = subject.delivered().await;
                    let under = format!(
                        "under ⟨{}⟩",
                        ops.iter()
                            .map(|op| match op {
                                DeliveryOp::Write => "write",
                                DeliveryOp::Transition => "transition",
                            })
                            .collect::<Vec<_>>()
                            .join(",")
                    );
                    for id in &written {
                        match delivered.iter().filter(|d| *d == id).count() {
                            1 => {}
                            0 => {
                                return Err(format!(
                                    "L3: event ⟨{id}⟩ was delivered 0 times {under}: lost across a transition"
                                ));
                            }
                            n => {
                                return Err(format!(
                                    "L3: event ⟨{id}⟩ was delivered {n} times {under}"
                                ));
                            }
                        }
                    }
                    Ok(())
                })
                .map_err(TestCaseError::fail)
        })
        .map_err(|failure| failure.to_string())
}
