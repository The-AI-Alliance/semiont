//! `job.claim`: a worker's claims and the jobs it comes to hold.
//!
//! The rules are docs/protocol/WORKER-CONTRACT.md's, and the worker
//! conformance suite (tests/conformance/worker) holds them on the wire. These
//! are the same rules over a transport the test answers by hand, where a
//! moment between two frames can be chosen: the stand-in dispatcher below
//! answers each `job:claim` with what a test offered, refused, or with
//! nothing pending, and the stand-in record answers each commit and each
//! question a commit asks.

use semiont::bus::reply_channels_for;
use semiont::claims::{
    ClaimOptions, ClaimRefusal, ClaimTiming, Claims, HeldJob, JOB_CLAIM_CHANNELS,
    JOB_COMMIT_CHANNELS, JobFailure,
};
use semiont::client::SemiontClient;
use semiont::errors::{BusRequestError, BusRequestErrorCode, SemiontError};
use semiont::testing::{FaultAction, FaultyTransport, TestClientOptions, create_test_client};
use semiont::transport::{ConnectionState, Frame};
use semiont::types::DurabilityEvidence::{
    Acknowledged, ProbeConfirmed, ProbeRefused, ProbeUnreachable,
};
use semiont::types::{
    Annotation, DurabilityEvidence, FailureClass, JobDetectionResult, JobFilter, JobProgress,
    JobType, ResourceId, YieldJobResult,
};
use serde_json::{Map, Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What the stand-in dispatcher answers the next claims with, and what the
/// stand-in record answers a commit and a question with.
///
/// The record acknowledges every commit and has every annotation it is asked
/// after, unless a test gives it a failure to answer with. Whether its answer
/// arrives is the wire's: a reply the schedule drops is one nobody got.
#[derive(Default)]
struct Queue {
    offered: Mutex<VecDeque<Value>>,
    refusals: Mutex<VecDeque<Value>>,
    /// The failure the record refuses a commit with.
    commit_refused: Mutex<Option<Value>>,
    /// The failure the record answers a question with.
    question_failed: Mutex<Option<Value>>,
}

struct World {
    client: Arc<SemiontClient>,
    transport: FaultyTransport,
    queue: Arc<Queue>,
}

/// An annotation as the wire carries one: already made, with its id.
fn annotated(id: &str) -> Value {
    json!({
        "@context": "http://www.w3.org/ns/anno.jsonld",
        "type": "Annotation",
        "id": id,
        "motivation": "highlighting",
        "target": {
            "source": "res-1",
            "selector": { "type": "TextQuoteSelector", "exact": format!("the words of {id}") },
        },
        "created": "2026-01-01T00:00:00.000Z",
    })
}

/// An annotation as a worker hands one to a commit.
fn annotation(id: &str) -> Annotation {
    serde_json::from_value(annotated(id)).expect("an annotation")
}

fn resource(id: &str) -> ResourceId {
    id.parse().expect("a resource id")
}

/// A client over a transport whose i-th request meets `schedule[i % len]`.
fn world_meeting(schedule: Vec<FaultAction>) -> World {
    let queue = Arc::new(Queue::default());
    let offered = queue.clone();
    let transport = FaultyTransport::answering(schedule, move |operation, payload| {
        let nothing = || format!("nothing is scripted to answer {operation}");
        match operation {
            "job:claim" => offered
                .offered
                .lock()
                .expect("the queue")
                .pop_front()
                .map(Some)
                .ok_or_else(nothing),
            "mark:commit" => {
                let ids: Vec<Value> = payload
                    .get("annotations")
                    .and_then(Value::as_array)
                    .ok_or_else(nothing)?
                    .iter()
                    .map(|committed| committed["id"].clone())
                    .collect();
                Ok(Some(
                    json!({ "persisted": ids.len(), "annotationIds": ids }),
                ))
            }
            "browse:annotation-requested" => {
                let asked = payload
                    .get("annotationId")
                    .and_then(Value::as_str)
                    .ok_or_else(nothing)?;
                Ok(Some(json!({
                    "annotation": annotated(asked), "resource": null, "resolvedResource": null,
                })))
            }
            _ => Err(nothing()),
        }
    });
    let deciding = queue.clone();
    transport.refuse_when(move |operation, _| match operation {
        "job:claim" => {
            if let Some(refusal) = deciding.refusals.lock().expect("the queue").pop_front() {
                return Some(refusal);
            }
            deciding
                .offered
                .lock()
                .expect("the queue")
                .is_empty()
                .then(|| json!({ "message": "No pending job matches", "code": "none-pending" }))
        }
        "mark:commit" => deciding.commit_refused.lock().expect("the record").clone(),
        "browse:annotation-requested" => {
            deciding.question_failed.lock().expect("the record").clone()
        }
        _ => None,
    });
    let client = create_test_client(TestClientOptions {
        transport: Some(transport.clone()),
        ..TestClientOptions::default()
    })
    .client;
    World {
        client,
        transport,
        queue,
    }
}

fn world() -> World {
    world_meeting(vec![])
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("an object")
}

/// A running job as the dispatcher returns one from a claim.
fn running(id: &str, job_type: &str, metadata: Value, params: Value) -> Value {
    let mut job = json!({
        "status": "running",
        "metadata": {
            "id": id,
            "type": job_type,
            "userId": "did:web:kb.example:users:u",
            "created": "2026-01-01T00:00:00.000Z",
            "retryCount": 0,
            "maxRetries": 1,
        },
        "params": { "resourceId": "res-1" },
        "startedAt": "2026-01-01T00:00:01.000Z",
        "progress": {},
    });
    for (part, more) in [("metadata", metadata), ("params", params)] {
        job[part]
            .as_object_mut()
            .expect("an object")
            .extend(object(more));
    }
    job
}

fn mark(motivation: &str) -> JobFilter {
    serde_json::from_value(json!({ "jobType": "mark", "params": { "motivation": motivation } }))
        .expect("a filter")
}

fn everything() -> Vec<JobFilter> {
    let mut accepts: Vec<JobFilter> = [
        "highlighting",
        "commenting",
        "assessing",
        "linking",
        "tagging",
    ]
    .into_iter()
    .map(mark)
    .collect();
    accepts.push(serde_json::from_value(json!({ "jobType": "yield" })).expect("a filter"));
    accepts
}

/// An announcement of a `mark` job of `motivation`. It states less than the
/// spec has a tagging job state, on purpose: an announcement is compared with
/// a claim as it came, so one this SDK could not type still wakes a worker
/// whose claim it matches.
fn queued(motivation: &str) -> Value {
    json!({
        "jobId": "job-announced", "jobType": "mark", "resourceId": "res-9",
        "userId": "did:web:kb.example:users:u", "params": { "motivation": motivation },
    })
}

impl World {
    fn offer(&self, job: Value) {
        self.queue.offered.lock().expect("the queue").push_back(job);
    }

    fn refuse(&self, failure: Value) {
        self.queue
            .refusals
            .lock()
            .expect("the queue")
            .push_back(failure);
    }

    fn claims(&self, accepts: Vec<JobFilter>) -> Claims {
        self.client.job.claim(ClaimOptions::new(accepts))
    }

    /// A broadcast the gateway relays to this worker.
    fn relay(&self, channel: &str, payload: Value) {
        self.transport.deliver(Frame {
            channel: channel.to_owned(),
            payload: object(payload),
            correlation_id: None,
            scope: None,
            trace: None,
        });
    }

    /// Every `job:claim` sent so far.
    fn claimed(&self) -> Vec<Value> {
        self.sent("job:claim")
    }

    fn sent(&self, channel: &str) -> Vec<Value> {
        self.transport
            .emitted()
            .into_iter()
            .filter(|frame| frame.channel == channel)
            .map(|frame| Value::Object(frame.payload))
            .collect()
    }

    /// Every request sent on `channel` so far, in order, as it was sent.
    fn requested(&self, channel: &str) -> Vec<Frame> {
        self.transport
            .emitted()
            .into_iter()
            .filter(|frame| frame.channel == channel)
            .collect()
    }

    /// The record refuses every commit with `failure`.
    fn refuse_commits(&self, failure: Value) {
        *self.queue.commit_refused.lock().expect("the record") = Some(failure);
    }

    /// The record answers every question with `failure`, or with the
    /// annotation asked after when there is none.
    fn answer_questions(&self, failure: Option<Value>) {
        *self.queue.question_failed.lock().expect("the record") = failure;
    }

    /// A worker's claims whose commits wait `QUICK_COMMIT`.
    fn quick_claims(&self) -> Claims {
        self.client.job.claim(ClaimOptions {
            timing: ClaimTiming {
                mark_commit: QUICK_COMMIT,
                ..ClaimTiming::default()
            },
            ..ClaimOptions::new(everything())
        })
    }

    /// Commit one annotation, with the record played so that the commit
    /// observes `how`, in a world whose wire is played for it
    /// (`world_observing`).
    async fn commit_observing(
        &self,
        job: &HeldJob,
        how: DurabilityEvidence,
        id: &str,
    ) -> Result<(), SemiontError> {
        self.answer_questions(
            (how == ProbeRefused).then(|| json!({ "message": "Annotation not found" })),
        );
        job.commit(&resource("res-1"), vec![annotation(id)]).await
    }

    /// Everything said that is not a request: the lifecycle, in order.
    fn said(&self) -> Vec<(String, Value)> {
        self.transport
            .emitted()
            .into_iter()
            .filter(|frame| {
                !["job:claim", "mark:commit", "browse:annotation-requested"]
                    .contains(&frame.channel.as_str())
            })
            .map(|frame| {
                assert_eq!(
                    (frame.scope, frame.correlation_id),
                    (None, None),
                    "{} is global, and nobody's reply",
                    frame.channel
                );
                (frame.channel, Value::Object(frame.payload))
            })
            .collect()
    }
}

/// Let what is ready to run, run. The clock is paused, so this takes no time.
async fn turn() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

/// The job the claims hand out next.
async fn held(claims: &Claims) -> HeldJob {
    match claims.next().await {
        Some(Ok(job)) => job,
        Some(Err(refusal)) => panic!("the claim was refused: {refusal:?}"),
        None => panic!("the claiming has ended"),
    }
}

fn found(found: u64, persisted: u64) -> semiont::types::MarkJobResult {
    JobDetectionResult::new(found, persisted).into()
}

/// Complete a held `mark` job that found nothing. A completion is its verb's,
/// so the verb is matched first.
async fn finish(job: HeldJob) {
    match job {
        HeldJob::Mark(job) => job
            .complete(found(0, 0))
            .await
            .expect("the completion is sent"),
        HeldJob::Yield(_) => panic!("not a mark job"),
    }
}

/// A commit's wait, for a test that must not wait a minute for the record.
const QUICK_COMMIT: Duration = Duration::from_millis(20);

/// What the wire does to a commit's reply, and to the reply to the question
/// a lost one asks, for the commit to observe `how`.
fn wire_for(how: DurabilityEvidence) -> Vec<FaultAction> {
    match how {
        Acknowledged => vec![FaultAction::Deliver],
        ProbeConfirmed | ProbeRefused => {
            vec![FaultAction::DropReply, FaultAction::Deliver]
        }
        ProbeUnreachable => {
            vec![FaultAction::DropReply, FaultAction::DropReply]
        }
    }
}

/// A world whose first claim is answered, and whose commits after it observe
/// `observed`, in order.
fn world_observing(observed: &[DurabilityEvidence]) -> World {
    let mut schedule = vec![FaultAction::Deliver];
    schedule.extend(observed.iter().flat_map(|how| wire_for(*how)));
    world_meeting(schedule)
}

/// The failure of a `mark:commit` nobody acknowledged within `waited`.
fn unacknowledged(waited: Duration) -> SemiontError {
    SemiontError::Bus(BusRequestError::new(
        BusRequestErrorCode::Timeout,
        format!(
            "Bus request timed out after {}ms on mark:commit-ok",
            waited.as_millis()
        ),
    ))
}

// ── A worker claims when it becomes idle, and at no other time ──────────

#[tokio::test(start_paused = true)]
async fn claims_nothing_until_its_claims_are_read() {
    let w = world();
    let _claims = w.claims(everything());
    turn().await;
    assert!(w.claimed().is_empty());
}

#[tokio::test(start_paused = true)]
async fn claims_once_read_with_what_it_accepts_and_holds_the_job_as_the_record_states_it() {
    let w = world();
    let cursor = json!({ "next": 1200, "size": 800, "found": 4, "emitted": 3, "errors": 0 });
    w.offer(running(
        "job-1",
        "mark",
        json!({ "retryCount": 1, "maxRetries": 3, "completedUnits": ["Person"], "unitCursors": { "Place": cursor } }),
        json!({ "motivation": "highlighting", "density": 3 }),
    ));
    let claims = w.claims(vec![mark("highlighting")]);

    let job = held(&claims).await;

    assert_eq!(
        w.claimed(),
        [json!({ "accepts": [{ "jobType": "mark", "params": { "motivation": "highlighting" } }] })]
    );
    assert_eq!(job.job_id().as_str(), "job-1");
    assert_eq!(job.job_type(), JobType::Mark);
    assert_eq!(job.resource_id().as_str(), "res-1");
    assert_eq!(
        serde_json::to_value(job.params()).expect("params"),
        json!({ "resourceId": "res-1", "motivation": "highlighting", "density": 3 })
    );
    assert_eq!(
        (job.retry_count(), job.max_retries(), job.attempt()),
        (1, 3, 2)
    );
    assert_eq!(job.completed_units(), ["Person"]);
    assert_eq!(
        serde_json::to_value(job.unit_cursors()).expect("cursors"),
        json!({ "Place": cursor })
    );
    assert_eq!(job.annotation_id(), None);
    assert!(!*job.cancelled().borrow());
    finish(job).await;
}

#[tokio::test(start_paused = true)]
async fn waits_for_the_stream_to_open_before_the_first_claim() {
    let w = world();
    w.transport.set_state(ConnectionState::Connecting);
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.claims(everything());
    let reading = tokio::spawn(async move { held(&claims).await });
    turn().await;
    assert!(
        w.claimed().is_empty(),
        "a claim on a closed stream would only be refused here"
    );

    w.transport.set_state(ConnectionState::Open);
    let job = reading.await.expect("read");
    assert_eq!(w.claimed().len(), 1);
    finish(job).await;
}

#[tokio::test(start_paused = true)]
async fn claims_again_as_soon_as_a_job_is_settled_however_it_is_settled() {
    let w = world();
    for id in ["job-1", "job-2", "job-3"] {
        w.offer(running(id, "mark", json!({}), json!({})));
    }
    let claims = w.claims(everything());

    finish(held(&claims).await).await;
    let second = held(&claims).await;
    assert_eq!((w.claimed().len(), second.job_id().as_str()), (2, "job-2"));

    second
        .fail("kaboom", JobFailure::default())
        .await
        .expect("sent");
    let third = held(&claims).await;
    assert_eq!(w.claimed().len(), 3);

    third.cancel(None, None).await.expect("sent");
    turn().await;
    assert_eq!(
        w.claimed().len(),
        4,
        "the settle asks, and is told nothing is pending"
    );
}

#[tokio::test(start_paused = true)]
async fn a_matching_announcement_claims_and_one_that_matches_no_filter_does_not() {
    let w = world();
    let claims = w.claims(vec![mark("tagging")]);
    let reading = tokio::spawn(async move { held(&claims).await });
    turn().await;
    assert_eq!(
        w.claimed().len(),
        1,
        "the first claim, answered with nothing pending"
    );

    w.relay("job:queued", queued("highlighting"));
    turn().await;
    assert_eq!(
        w.claimed().len(),
        1,
        "no round trip for a job this worker does not take"
    );

    w.offer(running(
        "job-1",
        "mark",
        json!({}),
        json!({ "motivation": "tagging" }),
    ));
    w.relay("job:queued", queued("tagging"));
    let job = reading.await.expect("read");
    assert_eq!(w.claimed().len(), 2);
    finish(job).await;
}

#[tokio::test(start_paused = true)]
async fn an_announcement_while_a_job_is_held_is_ignored_and_the_settle_claims() {
    let w = world();
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.claims(everything());
    let job = held(&claims).await;

    w.relay("job:queued", queued("highlighting"));
    turn().await;
    assert_eq!(w.claimed().len(), 1, "no claim while holding a job");

    finish(job).await;
    turn().await;
    assert_eq!(w.claimed().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn an_announcement_during_a_claim_in_flight_earns_exactly_one_more() {
    // The first claim's answer takes a while; every later one is prompt.
    let w = world_meeting(vec![FaultAction::Delay(Duration::from_millis(50))]);
    let claims = w.claims(everything());
    tokio::spawn(async move { claims.next().await });
    turn().await;
    assert_eq!(w.claimed().len(), 1);

    // Two announcements land while it is in flight: one bit, not a counter.
    w.relay("job:queued", queued("highlighting"));
    w.relay("job:queued", queued("commenting"));
    turn().await;
    assert_eq!(w.claimed().len(), 1);

    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(w.claimed().len(), 2, "exactly one more");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        w.claimed().len(),
        2,
        "then nothing until the next idle moment"
    );
}

#[tokio::test(start_paused = true)]
async fn claims_when_the_stream_opens_again_and_not_while_it_stays_open() {
    let w = world();
    let claims = w.claims(everything());
    tokio::spawn(async move { claims.next().await });
    turn().await;
    assert_eq!(w.claimed().len(), 1);

    w.transport.set_state(ConnectionState::Reconnecting);
    turn().await;
    assert_eq!(w.claimed().len(), 1, "losing the stream claims nothing");
    w.transport.set_state(ConnectionState::Open);
    turn().await;
    assert_eq!(w.claimed().len(), 2, "regaining it asks");

    w.transport.set_state(ConnectionState::Open);
    turn().await;
    assert_eq!(w.claimed().len(), 2, "open to open is not an edge");
}

#[tokio::test(start_paused = true)]
async fn a_refusal_is_handed_out_with_its_code_and_nothing_pending_is_not_one() {
    let w = world();
    w.refuse(json!({ "message": "the caller is not a worker for this knowledge base", "code": "unauthorized" }));
    let claims = w.claims(everything());

    assert_eq!(
        claims.next().await.map(|handed| handed.err()),
        Some(Some(ClaimRefusal {
            code: Some(BusRequestErrorCode::Unauthorized),
            message: "the caller is not a worker for this knowledge base".to_owned(),
        }))
    );
    assert_eq!(w.claimed().len(), 1, "it does not ask again by itself");

    // A refusal with no code is a rejection; and an empty queue is told to nobody.
    w.refuse(json!({ "message": "the queue could not be read" }));
    w.relay("job:queued", queued("highlighting"));
    assert_eq!(
        claims
            .next()
            .await
            .and_then(|handed| handed.err())
            .map(|refusal| refusal.code),
        Some(Some(BusRequestErrorCode::Rejected))
    );
    w.relay("job:queued", queued("highlighting"));
    turn().await;
    w.offer(running("job-1", "mark", json!({}), json!({})));
    w.relay("job:queued", queued("highlighting"));
    let job = held(&claims).await;
    assert_eq!(
        w.claimed().len(),
        4,
        "the third was answered with nothing pending, and said nothing"
    );
    finish(job).await;
}

// WORKER-CONTRACT C9. A worker must not run what it cannot read, and must
// not stop claiming because of it.
#[tokio::test(start_paused = true)]
async fn a_reply_that_names_no_job_is_refused_here_never_held_and_the_next_announcement_claims() {
    let whole = running("job-1", "mark", json!({}), json!({}));
    let mut no_id = whole.clone();
    no_id["metadata"]
        .as_object_mut()
        .expect("metadata")
        .remove("id");
    let mut no_verb = whole.clone();
    no_verb["metadata"]["type"] = json!("weave");
    let mut no_params = whole.clone();
    no_params.as_object_mut().expect("a job").remove("params");
    for reply in [json!({ "status": "running" }), no_id, no_verb, no_params] {
        let w = world();
        w.offer(reply.clone());
        let claims = w.claims(everything());

        let refusal = claims
            .next()
            .await
            .and_then(|handed| handed.err())
            .unwrap_or_else(|| panic!("{reply} was held"));
        assert_eq!(
            refusal.code, None,
            "a failure of this worker's own, under no bus code"
        );

        w.offer(whole.clone());
        w.relay("job:queued", queued("highlighting"));
        let job = held(&claims).await;
        assert_eq!(
            w.claimed().len(),
            2,
            "the worker is not left with a claim in flight"
        );
        finish(job).await;
    }
}

// WORKER-CONTRACT C10. The table's wait is ten seconds; a caller that must
// not wait it out states its own.
#[tokio::test(start_paused = true)]
async fn a_claim_nobody_answers_is_given_up_after_its_timeout_and_reported() {
    let w = world_meeting(vec![FaultAction::DropReply, FaultAction::Deliver]);
    let claims = w.client.job.claim(ClaimOptions {
        timing: ClaimTiming {
            job_claim: Duration::from_millis(20),
            ..ClaimTiming::default()
        },
        ..ClaimOptions::new(everything())
    });

    let refusal = claims.next().await.and_then(|handed| handed.err());
    assert_eq!(
        refusal.map(|refusal| refusal.code),
        Some(Some(BusRequestErrorCode::Timeout))
    );

    w.offer(running("job-1", "mark", json!({}), json!({})));
    w.relay("job:queued", queued("highlighting"));
    finish(held(&claims).await).await;
}

#[tokio::test(start_paused = true)]
async fn a_stream_that_does_not_name_what_claiming_reads_cannot_carry_a_workers_claims() {
    assert_eq!(
        JOB_CLAIM_CHANNELS,
        [
            "job:claimed",
            "job:claim-failed",
            "job:queued",
            "job:cancel-requested"
        ]
    );
    // A worker on such a stream would claim once and never be woken, or never
    // hear a cancellation, with nothing to show for it.
    for channel in JOB_CLAIM_CHANNELS {
        let w = world();
        w.transport.unname(channel);
        let claims = w.claims(everything());

        let refusal = claims
            .next()
            .await
            .and_then(|handed| handed.err())
            .expect("a refusal");
        assert_eq!(refusal.code, Some(BusRequestErrorCode::Unsubscribed));
        assert!(refusal.message.contains(channel), "{}", refusal.message);
        assert!(claims.next().await.is_none(), "and the claiming has ended");
        assert!(w.claimed().is_empty());
    }
}

// ── The held job ────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn a_held_job_says_its_whole_lifecycle_itself() {
    let w = world();
    w.offer(running(
        "job-1",
        "mark",
        json!({ "retryCount": 1 }),
        json!({}),
    ));
    let claims = w.claims(everything());
    let job = held(&claims).await;
    let cursor = json!({ "next": 1200, "size": 800, "found": 4, "emitted": 3, "errors": 0 });

    job.start().await.expect("sent");
    job.progress(JobProgress::new(40.0)).await.expect("sent");
    job.checkpoint(
        vec!["Person".to_owned()],
        Some(serde_json::from_value(json!({ "Place": cursor })).expect("cursors")),
    )
    .await
    .expect("sent");
    job.commit(&resource("res-1"), vec![annotation("ann-1")])
        .await
        .expect("established");
    let HeldJob::Mark(job) = job else {
        panic!("the record says mark")
    };
    job.complete(found(9, 7)).await.expect("sent");

    let identity =
        json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 2 });
    let with = |more: Value| {
        let mut said = object(identity.clone());
        said.extend(object(more));
        Value::Object(said)
    };
    assert_eq!(
        w.said(),
        [
            ("job:start".to_owned(), identity.clone()),
            (
                "job:report-progress".to_owned(),
                with(json!({ "percentage": 40.0, "progress": { "percentage": 40.0 } }))
            ),
            (
                "job:checkpoint".to_owned(),
                json!({ "jobId": "job-1", "completedUnits": ["Person"], "unitCursors": { "Place": cursor } })
            ),
            (
                "job:complete".to_owned(),
                with(
                    json!({ "result": { "found": 9, "persisted": 7 }, "durability": "acknowledged" })
                )
            ),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn a_yield_job_focused_on_an_annotation_is_anchored_to_it_and_says_so() {
    let w = world();
    w.offer(running(
        "job-1",
        "yield",
        json!({ "maxRetries": 0 }),
        json!({ "context": { "focus": { "kind": "annotation", "annotation": { "id": "ann-7" } } } }),
    ));
    w.offer(running(
        "job-2",
        "yield",
        json!({}),
        json!({ "context": { "focus": { "kind": "resource" } } }),
    ));
    let claims = w.claims(everything());
    let job = held(&claims).await;
    assert_eq!(job.annotation_id().map(|id| id.as_str()), Some("ann-7"));

    job.start().await.expect("sent");
    job.progress(JobProgress::new(5.0)).await.expect("sent");
    let HeldJob::Yield(job) = job else {
        panic!("the record says yield")
    };
    let made: YieldJobResult = serde_json::from_value(
        json!({ "resourceId": "res-new", "resourceName": "Ouranos", "truncated": false }),
    )
    .expect("a result");
    job.complete(made).await.expect("sent");

    let identity = json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": "yield", "attempt": 1, "annotationId": "ann-7" });
    let said = w.said();
    assert_eq!(said[0].1, identity);
    assert_eq!(
        said[1].1["progress"],
        json!({ "percentage": 5.0, "annotationId": "ann-7" })
    );
    assert_eq!(said[2].1["annotationId"], json!("ann-7"));
    assert_eq!(
        said[2].1["result"],
        json!({ "resourceId": "res-new", "resourceName": "Ouranos", "truncated": false })
    );

    // One focused on a resource is anchored to none.
    let other = held(&claims).await;
    assert_eq!(other.annotation_id(), None);
    other.cancel(None, None).await.expect("sent");
}

#[tokio::test(start_paused = true)]
async fn job_start_is_a_held_jobs_first_message_said_once() {
    let w = world();
    w.offer(running("job-1", "mark", json!({}), json!({})));
    w.offer(running("job-2", "mark", json!({}), json!({})));
    let claims = w.claims(everything());

    let job = held(&claims).await;
    job.start().await.expect("sent");
    assert!(job.start().await.is_err(), "said twice");
    finish(job).await;

    let late = held(&claims).await;
    late.progress(JobProgress::new(1.0)).await.expect("sent");
    assert!(late.start().await.is_err(), "said after another message");
    finish(late).await;
    assert_eq!(w.sent("job:start").len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_failure_says_whether_it_will_be_retried_from_the_records_budget_and_its_class() {
    let w = world();
    w.offer(running(
        "job-1",
        "mark",
        json!({ "retryCount": 0, "maxRetries": 1 }),
        json!({}),
    ));
    w.offer(running(
        "job-3",
        "mark",
        json!({ "retryCount": 1, "maxRetries": 1 }),
        json!({}),
    ));
    let claims = w.claims(everything());

    held(&claims)
        .await
        .fail(
            "the model timed out",
            JobFailure {
                completed_units: Some(vec!["Person".to_owned()]),
                ..JobFailure::default()
            },
        )
        .await
        .expect("sent");
    held(&claims)
        .await
        .fail("the model timed out", JobFailure::default())
        .await
        .expect("sent");

    assert_eq!(
        w.sent("job:fail"),
        [
            // A class the worker does not know is not stated.
            json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 1, "error": "the model timed out", "completedUnits": ["Person"], "willRetry": true }),
            json!({ "resourceId": "res-1", "jobId": "job-3", "jobType": "mark", "attempt": 2, "error": "the model timed out", "willRetry": false }),
        ]
    );

    // A failure known to be deterministic is not retried, whatever budget is
    // left; and it says what a commit that was not established observed.
    let known = world_observing(&[ProbeRefused]);
    known.offer(running(
        "job-2",
        "mark",
        json!({ "retryCount": 0, "maxRetries": 1 }),
        json!({}),
    ));
    let claims = known.quick_claims();
    let job = held(&claims).await;
    assert_eq!(
        known.commit_observing(&job, ProbeRefused, "ann-1").await,
        Err(unacknowledged(QUICK_COMMIT))
    );
    job.fail(
        "the resource has no text",
        JobFailure {
            failure_class: Some(FailureClass::Deterministic),
            ..JobFailure::default()
        },
    )
    .await
    .expect("sent");
    assert_eq!(
        known.sent("job:fail"),
        [
            json!({ "resourceId": "res-1", "jobId": "job-2", "jobType": "mark", "attempt": 1, "error": "the resource has no text", "failureClass": "deterministic", "willRetry": false, "durability": "probe-refused" })
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn a_cancel_says_the_units_finished_and_nothing_the_command_does_not_name() {
    let w = world();
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.claims(everything());

    held(&claims)
        .await
        .cancel(Some(vec!["Person".to_owned()]), None)
        .await
        .expect("sent");

    assert_eq!(
        w.said(),
        [(
            "job:cancel".to_owned(),
            json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "completedUnits": ["Person"] })
        )]
    );
}

#[tokio::test(start_paused = true)]
async fn a_cancellation_that_names_the_held_job_is_signalled_and_any_other_is_not() {
    let w = world();
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.claims(everything());
    let job = held(&claims).await;
    let cancelled = job.cancelled();

    w.relay("job:cancel-requested", json!({ "jobId": "job-7" }));
    w.relay("job:cancel-requested", json!({ "jobType": "mark" }));
    turn().await;
    assert!(!*cancelled.borrow());

    w.relay("job:cancel-requested", json!({ "jobId": "job-1" }));
    turn().await;
    assert!(*cancelled.borrow());
    job.cancel(None, None).await.expect("sent");
}

// A handle let go of is a job nobody will settle. It is failed, so the queue
// retries it at once, where a job nobody answered for would stay `running`
// until the dispatcher's sweep.
#[tokio::test(start_paused = true)]
async fn a_held_job_dropped_unsettled_is_failed_and_the_worker_claims_again() {
    let w = world();
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.claims(everything());
    let job = held(&claims).await;
    tokio::spawn(async move { claims.next().await });

    drop(job);
    turn().await;

    assert_eq!(
        w.said(),
        [(
            "job:fail".to_owned(),
            json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 1, "error": "The worker let go of the job without settling it", "willRetry": true })
        )]
    );
    assert_eq!(w.claimed().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_settled_job_says_nothing_more_when_its_handle_goes() {
    let w = world();
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.claims(everything());

    finish(held(&claims).await).await;
    turn().await;

    let said: Vec<String> = w.said().into_iter().map(|(channel, _)| channel).collect();
    assert_eq!(
        said,
        ["job:complete"],
        "one settle, and no failure after it"
    );
}

// WORKER-CONTRACT L8.
#[tokio::test(start_paused = true)]
async fn a_worker_that_stops_while_it_holds_a_job_fails_it_first_and_claims_nothing_more() {
    let w = world();
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.claims(everything());
    let job = held(&claims).await;

    claims.stop().await;

    assert_eq!(
        w.said(),
        [(
            "job:fail".to_owned(),
            json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 1, "error": "The worker stopped while it held the job", "willRetry": true })
        )]
    );
    assert!(claims.next().await.is_none(), "the claiming has ended");
    // The work went on, and learns the job is no longer its to settle.
    assert!(job.fail("too late", JobFailure::default()).await.is_err());
    turn().await;
    assert_eq!((w.sent("job:fail").len(), w.claimed().len()), (1, 1));
}

#[tokio::test(start_paused = true)]
async fn a_claim_answered_after_the_worker_stopped_is_failed_and_not_left_held_by_nobody() {
    let w = world_meeting(vec![FaultAction::Delay(Duration::from_millis(50))]);
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.claims(everything());
    tokio::select! {
        handed = claims.next() => panic!("handed out before the answer: {}", handed.is_some()),
        _ = tokio::time::sleep(Duration::from_millis(10)) => {}
    }
    claims.stop().await;

    tokio::time::sleep(Duration::from_millis(100)).await;
    let failed = w.sent("job:fail");
    assert_eq!(failed.len(), 1);
    assert_eq!(
        failed[0]["error"],
        json!("The worker stopped while it held the job")
    );
}

// ── A held job commits for itself ───────────────────────────────────────
//
// WORKER-CONTRACT § Committing annotations (A1, A4, A5, A6).

/// Hold the one job a world offers, its commits waiting `QUICK_COMMIT`.
async fn holding(w: &World) -> (Claims, HeldJob) {
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.quick_claims();
    let job = held(&claims).await;
    (claims, job)
}

/// The one settle a world's worker has said on `channel`.
fn settle(w: &World, channel: &str) -> Value {
    let mut settles = w.sent(channel);
    assert_eq!(settles.len(), 1, "one {channel}");
    settles.remove(0)
}

#[test]
fn job_commit_channels_are_what_a_workers_stream_names_for_its_commits() {
    assert_eq!(
        JOB_COMMIT_CHANNELS,
        [
            "mark:commit-ok",
            "mark:commit-failed",
            "browse:annotation-result",
            "browse:annotation-failed"
        ]
    );
    // The replies of a commit and of the question it asks, as the registry
    // has them.
    assert_eq!(
        JOB_COMMIT_CHANNELS.to_vec(),
        reply_channels_for(&["mark:commit", "browse:annotation-requested"])
    );
}

#[tokio::test(start_paused = true)]
async fn a_commit_is_a_request_that_cites_the_job_and_is_established_when_the_record_acknowledges_it_and_not_before()
 {
    // The claim is answered at once, and the commit after a while.
    let w = world_meeting(vec![
        FaultAction::Deliver,
        FaultAction::Delay(Duration::from_millis(50)),
    ]);
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.claims(everything());
    let job = held(&claims).await;

    {
        // A job commits on more than one resource: here, on one that is not
        // its own.
        let elsewhere = resource("res-new");
        let committing = job.commit(&elsewhere, vec![annotation("ann-1"), annotation("ann-2")]);
        tokio::pin!(committing);
        tokio::select! {
            established = &mut committing => panic!("established before the record acknowledged it: {established:?}"),
            _ = tokio::time::sleep(Duration::from_millis(30)) => {}
        }
        let commits = w.requested("mark:commit");
        assert_eq!(
            commits
                .iter()
                .map(|commit| Value::Object(commit.payload.clone()))
                .collect::<Vec<_>>(),
            [
                json!({ "resourceId": "res-new", "annotations": [annotated("ann-1"), annotated("ann-2")], "jobId": "job-1" })
            ]
        );
        assert!(
            commits[0].correlation_id.is_some(),
            "a request, answered at its correlation id"
        );

        committing.await.expect("established");
    }

    assert!(
        w.requested("browse:annotation-requested").is_empty(),
        "nothing is asked of a commit the record acknowledged"
    );
    assert!(w.said().is_empty(), "a commit is no lifecycle message");
    job.start()
        .await
        .expect("the start is still the job's first message");

    finish(job).await;
    assert_eq!(
        settle(&w, "job:complete")["durability"],
        json!("acknowledged")
    );
}

// A commit asks only whether an answer came on its result channel. What the
// answer carries is the record's to state, and is not held to its type here:
// an acknowledgement this SDK cannot read is an acknowledgement all the same,
// and so is the answer to the question.
#[tokio::test(start_paused = true)]
async fn an_answer_this_sdk_cannot_type_establishes_the_commit_all_the_same() {
    let w = world_observing(&[Acknowledged, ProbeConfirmed]);
    w.transport.queue_reply("mark:commit", [None]);
    w.transport.queue_reply(
        "browse:annotation-requested",
        [Some(json!({ "annotation": "ann-1" }))],
    );
    let (_claims, job) = holding(&w).await;

    w.commit_observing(&job, Acknowledged, "ann-0")
        .await
        .expect("acknowledged");
    w.commit_observing(&job, ProbeConfirmed, "ann-1")
        .await
        .expect("established by asking");

    finish(job).await;
    assert_eq!(
        settle(&w, "job:complete")["durability"],
        json!("probe-confirmed")
    );
}

#[tokio::test(start_paused = true)]
async fn a_batch_of_no_annotations_is_no_commit_and_the_job_states_nothing_of_its_commits() {
    let w = world();
    let (_claims, job) = holding(&w).await;

    job.commit(&resource("res-1"), vec![])
        .await
        .expect("nothing to establish");
    assert!(w.requested("mark:commit").is_empty());

    finish(job).await;
    assert_eq!(
        settle(&w, "job:complete"),
        json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 1, "result": { "found": 0, "persisted": 0 } })
    );
}

#[tokio::test(start_paused = true)]
async fn a_commit_the_record_refuses_fails_with_the_records_reason_and_nothing_is_asked_or_observed()
 {
    let w = world();
    w.refuse_commits(json!({ "message": "the record could not append" }));
    let (_claims, job) = holding(&w).await;

    let refused = job
        .commit(&resource("res-1"), vec![annotation("ann-1")])
        .await;

    assert_eq!(
        refused,
        Err(SemiontError::Bus(BusRequestError {
            code: BusRequestErrorCode::Rejected,
            message: "the record could not append".to_owned(),
            failure: Some(object(json!({ "message": "the record could not append" }))),
        }))
    );
    tokio::time::sleep(3 * QUICK_COMMIT).await;
    assert!(
        w.requested("browse:annotation-requested").is_empty(),
        "the record has answered"
    );

    job.fail("the record could not append", JobFailure::default())
        .await
        .expect("sent");
    assert_eq!(
        settle(&w, "job:fail"),
        json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 1, "error": "the record could not append", "willRetry": true })
    );
}

#[tokio::test(start_paused = true)]
async fn a_commit_nobody_acknowledges_asks_whether_its_last_annotation_is_on_the_resource_and_is_established_when_it_is()
 {
    let w = world_observing(&[ProbeConfirmed]);
    let (_claims, job) = holding(&w).await;

    job.commit(
        &resource("res-new"),
        vec![annotation("ann-1"), annotation("ann-2")],
    )
    .await
    .expect("established by asking");

    let questions = w.requested("browse:annotation-requested");
    assert_eq!(
        questions
            .iter()
            .map(|question| Value::Object(question.payload.clone()))
            .collect::<Vec<_>>(),
        [json!({ "resourceId": "res-new", "annotationId": "ann-2" })],
        "the last, on the resource the batch was for"
    );
    assert!(questions[0].correlation_id.is_some());
    assert_eq!(
        w.requested("mark:commit").len(),
        1,
        "the record is asked what it holds; the batch is not sent again"
    );

    finish(job).await;
    assert_eq!(
        settle(&w, "job:complete")["durability"],
        json!("probe-confirmed")
    );
}

#[tokio::test(start_paused = true)]
async fn answered_that_it_is_not_there_the_commit_fails_as_its_unanswered_request_did_and_the_failure_says_what_was_observed()
 {
    let w = world_observing(&[ProbeRefused]);
    let (_claims, job) = holding(&w).await;

    let failed = w.commit_observing(&job, ProbeRefused, "ann-1").await;

    // The failure of the `mark:commit` request itself, and not one made of
    // it, nor the question's: its code and its message.
    assert_eq!(failed, Err(unacknowledged(QUICK_COMMIT)));
    assert_eq!(w.requested("browse:annotation-requested").len(), 1);

    job.fail("the commit was not established", JobFailure::default())
        .await
        .expect("sent");
    assert_eq!(
        settle(&w, "job:fail"),
        json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 1, "error": "the commit was not established", "durability": "probe-refused", "willRetry": true })
    );
}

#[tokio::test(start_paused = true)]
async fn not_answered_it_waits_as_long_again_fails_the_same_way_and_says_that_nobody_answered() {
    let wait = Duration::from_millis(60);
    let w = world_observing(&[ProbeUnreachable]);
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.client.job.claim(ClaimOptions {
        timing: ClaimTiming {
            mark_commit: wait,
            ..ClaimTiming::default()
        },
        ..ClaimOptions::new(everything())
    });
    let job = held(&claims).await;

    let began = tokio::time::Instant::now();
    let failed = w.commit_observing(&job, ProbeUnreachable, "ann-1").await;
    let waited = began.elapsed();

    assert_eq!(failed, Err(unacknowledged(wait)));
    assert_eq!(w.requested("browse:annotation-requested").len(), 1);
    assert!(
        waited >= 2 * wait,
        "the acknowledgement's wait, and then the answer's: {waited:?}"
    );

    job.fail("the commit was not established", JobFailure::default())
        .await
        .expect("sent");
    assert_eq!(
        settle(&w, "job:fail")["durability"],
        json!("probe-unreachable")
    );
}

// Only a failure the record answered the question with, under no code of its
// own, says the annotation is not there. Any other failure of the question
// says nobody answered it.
#[tokio::test(start_paused = true)]
async fn a_question_that_fails_any_other_way_is_observed_as_not_answered() {
    // The service that answers the question is not connected.
    let unavailable = world_observing(&[ProbeRefused]);
    unavailable.answer_questions(Some(
        json!({ "message": "nobody answers browse:annotation-requested", "code": "peer-unavailable" }),
    ));
    // The gateway did not take the question.
    let untaken = world_meeting(vec![
        FaultAction::Deliver,
        FaultAction::DropReply,
        FaultAction::RejectEmit,
    ]);
    for w in [unavailable, untaken] {
        let (_claims, job) = holding(&w).await;

        let failed = job
            .commit(&resource("res-1"), vec![annotation("ann-1")])
            .await;

        assert_eq!(
            failed,
            Err(unacknowledged(QUICK_COMMIT)),
            "the commit's own failure, never the question's"
        );
        assert_eq!(w.requested("browse:annotation-requested").len(), 1);
        job.fail("the commit was not established", JobFailure::default())
            .await
            .expect("sent");
        assert_eq!(
            settle(&w, "job:fail")["durability"],
            json!("probe-unreachable")
        );
    }
}

#[tokio::test(start_paused = true)]
async fn any_other_failure_of_the_commits_request_is_returned_as_it_is_and_nothing_is_asked_or_observed()
 {
    // The gateway did not take the commit.
    let w = world_meeting(vec![FaultAction::Deliver, FaultAction::RejectEmit]);
    let (_claims, job) = holding(&w).await;

    let failed = job
        .commit(&resource("res-1"), vec![annotation("ann-1")])
        .await
        .expect_err("the commit was not taken");

    assert_eq!(failed.code(), "error");
    assert!(
        failed.to_string().contains("mark:commit"),
        "the request's own failure: {failed}"
    );
    tokio::time::sleep(3 * QUICK_COMMIT).await;
    assert!(w.requested("browse:annotation-requested").is_empty());

    job.fail("the gateway did not take the commit", JobFailure::default())
        .await
        .expect("sent");
    assert_eq!(settle(&w, "job:fail").get("durability"), None);
}

#[tokio::test(start_paused = true)]
async fn a_worker_whose_stream_does_not_name_the_commit_channels_claims_as_any_other_and_its_commit_fails_as_a_request_on_an_unnamed_reply_channel_does()
 {
    let w = world();
    for channel in JOB_COMMIT_CHANNELS {
        w.transport.unname(channel);
    }
    // A worker that never commits names nothing more.
    let (_claims, job) = holding(&w).await;

    let failed = job
        .commit(&resource("res-1"), vec![annotation("ann-1")])
        .await
        .expect_err("no reply could arrive");

    assert_eq!(failed.code(), "bus.unsubscribed");
    assert!(w.requested("mark:commit").is_empty());
    finish(job).await;
    assert_eq!(settle(&w, "job:complete").get("durability"), None);
}

// A settle takes the job, so a job its holder settled cannot be asked to
// commit. One its worker's stop settled can, and commits nothing.
#[tokio::test(start_paused = true)]
async fn a_settled_job_commits_nothing() {
    let w = world();
    let (claims, job) = holding(&w).await;
    claims.stop().await;

    for batch in [vec![annotation("ann-1")], vec![]] {
        let refused = job
            .commit(&resource("res-1"), batch)
            .await
            .expect_err("the job is settled");
        assert!(
            refused
                .to_string()
                .contains("already settled: it cannot say mark:commit"),
            "{refused}"
        );
    }
    assert!(w.requested("mark:commit").is_empty());
}

// A6. The job remembers the weakest of what its commits observed:
// acknowledged, then established by asking, then not established. The two
// ways of not being established are equally weak, and the first seen is kept.

const ESTABLISHED: [(&[DurabilityEvidence], DurabilityEvidence); 6] = [
    (&[Acknowledged], Acknowledged),
    (&[Acknowledged, Acknowledged], Acknowledged),
    (&[ProbeConfirmed], ProbeConfirmed),
    (&[Acknowledged, ProbeConfirmed], ProbeConfirmed),
    (&[ProbeConfirmed, Acknowledged], ProbeConfirmed),
    (
        &[Acknowledged, ProbeConfirmed, Acknowledged],
        ProbeConfirmed,
    ),
];

const NOT_ESTABLISHED: [(&[DurabilityEvidence], DurabilityEvidence); 8] = [
    (&[ProbeRefused], ProbeRefused),
    (&[ProbeUnreachable], ProbeUnreachable),
    (&[Acknowledged, ProbeRefused], ProbeRefused),
    (&[ProbeConfirmed, ProbeUnreachable], ProbeUnreachable),
    (&[ProbeRefused, Acknowledged], ProbeRefused),
    (&[ProbeUnreachable, ProbeConfirmed], ProbeUnreachable),
    (&[ProbeRefused, ProbeUnreachable], ProbeRefused),
    (&[ProbeUnreachable, ProbeRefused], ProbeUnreachable),
];

/// Hold a job and commit once for each of `observed`, in order.
async fn committed(observed: &[DurabilityEvidence]) -> (World, Claims, HeldJob) {
    let w = world_observing(observed);
    let (claims, job) = holding(&w).await;
    for (i, how) in observed.iter().enumerate() {
        let outcome = w.commit_observing(&job, *how, &format!("ann-{i}")).await;
        match how {
            Acknowledged | ProbeConfirmed => {
                assert_eq!(outcome, Ok(()), "{how:?} establishes the commit");
            }
            ProbeRefused | ProbeUnreachable => assert_eq!(
                outcome,
                Err(unacknowledged(QUICK_COMMIT)),
                "{how:?} does not"
            ),
        }
    }
    assert_eq!(w.requested("mark:commit").len(), observed.len());
    (w, claims, job)
}

#[tokio::test(start_paused = true)]
async fn a_completion_says_the_weakest_of_what_the_jobs_commits_observed() {
    for (observed, weakest) in ESTABLISHED.into_iter().chain(NOT_ESTABLISHED) {
        let (w, _claims, job) = committed(observed).await;

        finish(job).await;

        assert_eq!(
            settle(&w, "job:complete")["durability"],
            json!(weakest),
            "commits that observed {observed:?}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_failure_says_what_a_commit_that_was_not_established_observed() {
    for (observed, weakest) in NOT_ESTABLISHED {
        let (w, _claims, job) = committed(observed).await;

        job.fail("the commit was not established", JobFailure::default())
            .await
            .expect("sent");

        assert_eq!(
            settle(&w, "job:fail")["durability"],
            json!(weakest),
            "commits that observed {observed:?}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_failure_for_another_reason_says_nothing_of_commits_that_were_all_established() {
    for (observed, _) in ESTABLISHED {
        let (w, _claims, job) = committed(observed).await;

        job.fail("the model timed out", JobFailure::default())
            .await
            .expect("sent");

        assert_eq!(
            settle(&w, "job:fail").get("durability"),
            None,
            "commits that observed {observed:?}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_cancel_says_nothing_of_the_jobs_commits() {
    let (w, _claims, job) = committed(&[ProbeRefused]).await;

    job.cancel(None, None).await.expect("sent");

    assert_eq!(
        settle(&w, "job:cancel"),
        json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": "mark" })
    );
}

#[tokio::test(start_paused = true)]
async fn a_worker_that_stops_while_it_holds_a_job_whose_commit_was_not_established_says_so_as_it_fails_it()
 {
    let (w, claims, _job) = committed(&[ProbeUnreachable]).await;

    claims.stop().await;

    assert_eq!(
        settle(&w, "job:fail"),
        json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 1, "error": "The worker stopped while it held the job", "durability": "probe-unreachable", "willRetry": true })
    );
}

#[tokio::test(start_paused = true)]
async fn a_held_job_dropped_unsettled_says_what_a_commit_that_was_not_established_observed() {
    let (w, _claims, job) = committed(&[Acknowledged, ProbeRefused]).await;

    drop(job);
    turn().await;

    assert_eq!(
        settle(&w, "job:fail"),
        json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 1, "error": "The worker let go of the job without settling it", "durability": "probe-refused", "willRetry": true })
    );
}

// The job states what its commits observed; its holder is given no way to
// state it for it. A completion takes its result and nothing else, and these
// are a failure's every member.
#[tokio::test(start_paused = true)]
async fn what_a_jobs_commits_observed_is_the_held_jobs_alone_to_say() {
    let (w, _claims, job) = committed(&[ProbeConfirmed]).await;

    job.fail(
        "the model timed out",
        JobFailure {
            failure_class: None,
            completed_units: None,
            unit_cursors: None,
        },
    )
    .await
    .expect("sent");

    assert_eq!(settle(&w, "job:fail").get("durability"), None);
}

// ── Vitals and the stall rule ───────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn vitals_say_what_the_worker_heard_holds_and_has_done() {
    let w = world();
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.claims(everything());
    let empty = claims.vitals();
    assert_eq!(
        (
            empty.last_queued_event_at,
            empty.last_claim_at,
            empty.last_finished_at,
            empty.last_activity_at,
            empty.active_job,
            empty.jobs_completed
        ),
        (None, None, None, None, None, 0)
    );

    let job = held(&claims).await;
    let holding = claims.vitals();
    let active = holding.active_job.expect("a job is held");
    assert_eq!(
        (active.job_id.as_str(), active.job_type),
        ("job-1", JobType::Mark)
    );
    assert_eq!(Some(active.since), holding.last_claim_at);
    assert_eq!(holding.last_activity_at, holding.last_claim_at);
    assert_eq!(
        (holding.last_queued_event_at, holding.last_finished_at),
        (None, None)
    );

    // Every announcement received is stamped, matching or not.
    w.relay("job:queued", queued("highlighting"));
    turn().await;
    assert!(claims.vitals().last_queued_event_at.is_some());

    finish(job).await;
    let done = claims.vitals();
    assert_eq!((done.active_job, done.jobs_completed), (None, 1));
    assert!(done.last_finished_at.is_some());

    // A failure stamps the finish and counts no completion.
    turn().await;
    w.offer(running("job-2", "mark", json!({}), json!({})));
    w.relay("job:queued", queued("highlighting"));
    held(&claims)
        .await
        .fail("kaboom", JobFailure::default())
        .await
        .expect("sent");
    assert_eq!(claims.vitals().jobs_completed, 1);
}

fn quick() -> ClaimTiming {
    ClaimTiming {
        held_job_stall: Duration::from_millis(400),
        held_job_stall_check: Duration::from_millis(100),
        ..ClaimTiming::default()
    }
}

#[tokio::test(start_paused = true)]
async fn a_held_job_that_shows_no_activity_is_stalled_and_one_that_keeps_reporting_is_not() {
    let w = world();
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.client.job.claim(ClaimOptions {
        timing: quick(),
        ..ClaimOptions::new(everything())
    });
    let stalled = claims.stalled();
    let job = held(&claims).await;

    // It reports for a second, well past the threshold, and is never stalled.
    for step in 0..10 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        job.progress(JobProgress::new(f64::from(step)))
            .await
            .expect("sent");
    }
    assert_eq!(*stalled.borrow(), None, "however long it runs");

    tokio::time::sleep(Duration::from_millis(600)).await;
    let stall = stalled.borrow().clone().expect("a stall");
    assert_eq!(
        (stall.job_id.as_str(), stall.job_type),
        ("job-1", JobType::Mark)
    );
    assert!(stall.silent_for > Duration::from_millis(400));
    assert_eq!(stall.threshold, Duration::from_millis(400));
    finish(job).await;
}

// A commit is no lifecycle message, and is not activity.
#[tokio::test(start_paused = true)]
async fn a_held_job_that_only_commits_is_stalled_all_the_same() {
    let w = world();
    w.offer(running("job-1", "mark", json!({}), json!({})));
    let claims = w.client.job.claim(ClaimOptions {
        timing: quick(),
        ..ClaimOptions::new(everything())
    });
    let stalled = claims.stalled();
    let job = held(&claims).await;

    for step in 0..10 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        job.commit(&resource("res-1"), vec![annotation(&format!("ann-{step}"))])
            .await
            .expect("established");
    }

    let stall = stalled.borrow().clone().expect("a stall");
    assert_eq!(stall.job_id.as_str(), "job-1");
    finish(job).await;
}

#[tokio::test(start_paused = true)]
async fn an_idle_worker_is_never_stalled() {
    let w = world();
    let claims = w.client.job.claim(ClaimOptions {
        timing: quick(),
        ..ClaimOptions::new(everything())
    });
    let stalled = claims.stalled();
    tokio::spawn(async move { claims.next().await });

    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(*stalled.borrow(), None);
}
