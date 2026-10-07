//! Following a job (docs/protocol/JOBS.md § Following a job), through the two
//! methods that delegate one: `mark.delegate` and `yield_.delegate`. And a
//! client's end.

use semiont::client::SemiontClient;
use semiont::errors::SemiontError;
use semiont::namespaces::{Delegation, JobEvent, stall_deadline};
use semiont::testing::as_id;
use semiont::testing::{FaultAction, FaultyTransport, TestClientOptions, create_test_client};
use semiont::timing::{JOB_SILENCE, JOB_STATUS_POLL};
use semiont::transport::{ConnectionState, Envelope};
use semiont::types::{
    HighlightingJobParams, JobCompleteCommand, JobDetectionResult, JobResult, LinkingJobParams,
    TaggingJobParams,
};
use serde_json::{Map, Value, json};
use std::future::IntoFuture;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio::time::Instant;

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("an object")
}

fn client_over(transport: &FaultyTransport) -> Arc<SemiontClient> {
    create_test_client(TestClientOptions {
        transport: Some(transport.clone()),
        ..TestClientOptions::default()
    })
    .client
}

/// A client whose `job:create` is answered with `job-1`.
fn world() -> (Arc<SemiontClient>, FaultyTransport) {
    let transport = FaultyTransport::new(vec![]);
    transport.queue_reply("job:create", [Some(json!({ "jobId": "job-1" }))]);
    (client_over(&transport), transport)
}

/// Let what is ready run: replies are delivered and frames are read.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

/// Everything a follower gives, on a task of its own.
fn collected(mut running: Delegation) -> JoinHandle<Vec<Result<JobEvent, SemiontError>>> {
    tokio::spawn(async move {
        let mut seen = Vec::new();
        while let Some(item) = running.next().await {
            seen.push(item);
        }
        seen
    })
}

/// What a follower's task gives. A follower that never ends is a failure,
/// not a wait: an hour of the test's clock is longer than any of these takes.
async fn ended<T>(following: JoinHandle<T>) -> T {
    tokio::time::timeout(Duration::from_secs(3600), following)
        .await
        .expect("the follower ends")
        .expect("the follower ran")
}

fn highlighting(client: &SemiontClient) -> Delegation {
    client
        .mark
        .delegate(&as_id("res-1"), HighlightingJobParams::new())
}

fn frame(job_id: &str, more: Value) -> Map<String, Value> {
    let mut frame = object(json!({
        "resourceId": "res-1",
        "jobId": job_id,
        "jobType": "mark",
    }));
    frame.extend(object(more));
    frame
}

fn say(client: &SemiontClient, channel: &str, job_id: &str, more: Value) {
    client
        .bus()
        .emit(channel, frame(job_id, more), Envelope::default());
}

fn progress(percentage: f64) -> Value {
    json!({ "percentage": percentage, "progress": { "percentage": percentage } })
}

fn status(of: &str, more: Value) -> Option<Value> {
    let mut status = object(json!({
        "jobId": "job-1",
        "type": "mark",
        "status": of,
        "userId": "did:web:example.org:users:alice",
        "created": "2026-10-01T00:00:00.000Z",
    }));
    status.extend(object(more));
    Some(Value::Object(status))
}

fn asked(transport: &FaultyTransport, channel: &str) -> usize {
    transport
        .emitted()
        .iter()
        .filter(|frame| frame.channel == channel)
        .count()
}

fn kinds(seen: &[Result<JobEvent, SemiontError>]) -> Vec<String> {
    seen.iter()
        .map(|item| match item {
            Ok(JobEvent::Progress(progress)) => format!("progress {}", progress.percentage),
            Ok(JobEvent::Failed(_)) => "failed".to_owned(),
            Ok(JobEvent::Complete(_)) => "complete".to_owned(),
            Err(error) => format!("error {}", error.code()),
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_job_reports_its_progress_and_ends_with_its_completion() {
    let (client, _transport) = world();
    let following = collected(highlighting(&client));
    settle().await;

    say(&client, "job:report-progress", "job-1", progress(25.0));
    // Another job's frames are nobody's here.
    say(&client, "job:report-progress", "job-2", progress(99.0));
    say(&client, "job:complete", "job-2", json!({}));
    say(&client, "job:report-progress", "job-1", progress(75.0));
    say(&client, "job:complete", "job-1", json!({}));

    let seen = ended(following).await;
    assert_eq!(kinds(&seen), ["progress 25", "progress 75", "complete"]);
}

#[tokio::test(start_paused = true)]
async fn awaited_a_job_gives_its_completion() {
    let (client, _transport) = world();
    let running = highlighting(&client);
    let following = tokio::spawn(running.into_future());
    settle().await;
    say(&client, "job:report-progress", "job-1", progress(50.0));
    say(&client, "job:complete", "job-1", json!({}));

    // The completion itself: nothing to tell from a job's other events.
    let done: JobCompleteCommand = ended(following).await.expect("the job completes");
    assert_eq!(done.job_id, "job-1");
    assert_eq!(done.result, None);
}

#[tokio::test(start_paused = true)]
async fn awaited_a_mark_job_gives_its_counts_and_what_it_under_reported() {
    let (client, _transport) = world();
    let following = tokio::spawn(highlighting(&client).into_future());
    settle().await;
    say(
        &client,
        "job:complete",
        "job-1",
        json!({ "result": { "found": 7, "persisted": 5, "errors": 2, "underReportedPieces": 1 } }),
    );

    let done = ended(following).await.expect("the job completes");
    assert_eq!(
        done.result,
        Some(JobResult::DetectionResult(JobDetectionResult {
            errors: Some(2),
            under_reported_pieces: Some(1),
            ..JobDetectionResult::new(7, 5)
        }))
    );
}

#[tokio::test(start_paused = true)]
async fn a_delegated_job_is_created_with_the_parameters_it_was_given_its_motivation_among_them() {
    let (client, transport) = world();
    let sent = |transport: &FaultyTransport| {
        let created: Vec<Value> = transport
            .emitted()
            .iter()
            .filter(|frame| frame.channel == "job:create")
            .map(|frame| Value::Object(frame.payload.clone()))
            .collect();
        created.last().cloned().expect("a job:create was sent")
    };

    tokio::spawn(
        client
            .mark
            .delegate(
                &as_id("res-1"),
                LinkingJobParams {
                    include_descriptive_references: Some(true),
                    ..LinkingJobParams::new(vec!["Person".to_owned()])
                },
            )
            .into_future(),
    );
    settle().await;
    assert_eq!(
        sent(&transport),
        json!({ "jobType": "mark", "resourceId": "res-1", "params": {
            "motivation": "linking", "entityTypes": ["Person"], "includeDescriptiveReferences": true,
        } })
    );

    transport.queue_reply("job:create", [Some(json!({ "jobId": "job-2" }))]);
    tokio::spawn(
        client
            .mark
            .delegate(
                &as_id("res-2"),
                TaggingJobParams::new("irac", vec!["Issue".to_owned()]),
            )
            .into_future(),
    );
    settle().await;
    assert_eq!(
        sent(&transport),
        json!({ "jobType": "mark", "resourceId": "res-2", "params": {
            "motivation": "tagging", "schemaId": "irac", "categories": ["Issue"],
        } })
    );
}

#[tokio::test(start_paused = true)]
async fn frames_that_arrive_before_the_jobs_id_is_known_are_kept() {
    // The reply that names the job is a second behind the job's own frames.
    let transport = FaultyTransport::new(vec![FaultAction::Delay(Duration::from_secs(1))]);
    transport.queue_reply("job:create", [Some(json!({ "jobId": "job-1" }))]);
    let client = client_over(&transport);
    let following = collected(highlighting(&client));
    settle().await;

    say(&client, "job:report-progress", "job-2", progress(10.0));
    say(&client, "job:report-progress", "job-1", progress(40.0));
    say(&client, "job:complete", "job-1", json!({}));

    let seen = ended(following).await;
    assert_eq!(kinds(&seen), ["progress 40", "complete"]);
}

#[tokio::test(start_paused = true)]
async fn a_silent_job_is_asked_for_its_status_until_its_status_is_an_end() {
    let (client, transport) = world();
    transport.queue_reply(
        "job:status-requested",
        [status("running", json!({})), status("complete", json!({}))],
    );
    let started = Instant::now();
    let following = collected(highlighting(&client));

    tokio::time::sleep(JOB_SILENCE - Duration::from_millis(100)).await;
    assert_eq!(asked(&transport, "job:status-requested"), 0);

    let seen = ended(following).await;
    assert_eq!(kinds(&seen), ["complete"]);
    assert_eq!(asked(&transport, "job:status-requested"), 2);
    let took = started.elapsed();
    assert!(
        took >= JOB_SILENCE + JOB_STATUS_POLL && took < JOB_SILENCE + JOB_STATUS_POLL * 2,
        "the first ask comes after the silence and the second a poll later, not {took:?}"
    );
    match &seen[0] {
        // What the stream did not carry, from the status: which says what the
        // job was, and the follower knows what it was about.
        Ok(JobEvent::Complete(complete)) => {
            assert_eq!(complete.job_id, "job-1");
            assert_eq!(complete.resource_id, "res-1");
            assert_eq!(complete.result, None);
        }
        other => panic!("a completion was expected, not {other:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn every_frame_of_the_job_starts_the_silence_again() {
    let (client, transport) = world();
    let _following = collected(highlighting(&client));
    settle().await;

    tokio::time::sleep(JOB_SILENCE - Duration::from_secs(1)).await;
    say(&client, "job:report-progress", "job-1", progress(10.0));
    tokio::time::sleep(JOB_SILENCE - Duration::from_secs(1)).await;
    assert_eq!(asked(&transport, "job:status-requested"), 0);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(asked(&transport, "job:status-requested"), 1);
}

#[tokio::test(start_paused = true)]
async fn a_status_of_failed_ends_the_follower_as_a_failed_job() {
    let (client, transport) = world();
    transport.queue_reply(
        "job:status-requested",
        [status("failed", json!({ "error": "the worker gave up" }))],
    );
    let seen = ended(collected(highlighting(&client))).await;

    assert_eq!(kinds(&seen), ["error job.failed"]);
    match &seen[0] {
        Err(SemiontError::Job(failure)) => {
            assert_eq!(failure.message, "the worker gave up");
            assert_eq!(failure.job_id.as_deref(), Some("job-1"));
        }
        other => panic!("a job's failure was expected, not {other:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn a_failure_the_queue_will_retry_is_reported_and_followed_past() {
    let (client, transport) = world();
    let following = collected(highlighting(&client));
    settle().await;

    say(
        &client,
        "job:fail",
        "job-1",
        json!({ "error": "a blip", "willRetry": true }),
    );
    // The attempt that died is not asked about, however long the next takes.
    tokio::time::sleep(JOB_SILENCE * 3).await;
    assert_eq!(asked(&transport, "job:status-requested"), 0);

    say(&client, "job:report-progress", "job-1", progress(60.0));
    say(&client, "job:complete", "job-1", json!({}));
    let seen = ended(following).await;
    assert_eq!(kinds(&seen), ["failed", "progress 60", "complete"]);
}

#[tokio::test(start_paused = true)]
async fn a_failure_that_is_final_ends_the_follower_and_one_that_does_not_say_is_final() {
    for said in [json!({ "willRetry": false }), json!({})] {
        let (client, _transport) = world();
        let following = collected(highlighting(&client));
        settle().await;
        let mut failure = object(json!({ "error": "the budget is spent" }));
        failure.extend(object(said));
        say(&client, "job:fail", "job-1", Value::Object(failure));

        let seen = ended(following).await;
        assert_eq!(kinds(&seen), ["error job.failed"]);
        assert_eq!(
            seen[0].as_ref().expect_err("a failure").to_string(),
            "the budget is spent"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_reader_that_fell_behind_asks_at_once_for_what_it_missed() {
    let (client, transport) = world();
    transport.queue_reply("job:status-requested", [status("complete", json!({}))]);
    let started = Instant::now();
    let following = collected(highlighting(&client));
    settle().await;

    // More frames than a reader may fall behind by, before it reads any.
    for _ in 0..(semiont::transport::STREAM_BACKLOG + 10) {
        say(&client, "job:report-progress", "job-2", progress(1.0));
    }
    let seen = ended(following).await;
    assert_eq!(kinds(&seen), ["complete"]);
    assert!(
        started.elapsed() < JOB_SILENCE,
        "it asks without waiting out the silence"
    );
}

fn generation(max_tokens: Option<u64>) -> semiont::types::GenerationJobParams {
    let mut params = object(json!({
        "title": "A summary",
        "storageUri": "file://a-summary.md",
        "context": {
            "focus": { "kind": "resource", "resource": {
                "@context": "https://schema.org", "@id": "res-1", "name": "A resource",
                "representations": [{ "mediaType": "text/plain" }]
            } },
            "graph": { "nodes": [], "edges": [] },
            "metadata": {}
        }
    }));
    if let Some(max_tokens) = max_tokens {
        params.insert("maxTokens".to_owned(), json!(max_tokens));
    }
    serde_json::from_value(Value::Object(params)).expect("generation params")
}

#[tokio::test(start_paused = true)]
async fn a_generation_that_says_nothing_is_cancelled_and_given_up_on() {
    let (client, transport) = world();
    let started = Instant::now();
    let following = collected(
        client
            .yield_
            .delegate(generation(None), Some(Duration::from_secs(5))),
    );
    settle().await;

    // A frame of the job starts the wait again.
    tokio::time::sleep(Duration::from_secs(3)).await;
    client.bus().emit(
        "job:report-progress",
        object(json!({
            "resourceId": "res-1", "jobId": "job-1", "jobType": "yield",
            "percentage": 5.0, "progress": { "percentage": 5.0 }
        })),
        Envelope::default(),
    );

    let seen = ended(following).await;
    assert_eq!(kinds(&seen), ["progress 5", "error job.stalled"]);
    let took = started.elapsed();
    assert!(
        took >= Duration::from_secs(8) && took < Duration::from_secs(9),
        "five seconds after the last frame, not {took:?}"
    );
    match &seen[1] {
        Err(SemiontError::Job(stalled)) => assert_eq!(stalled.job_id.as_deref(), Some("job-1")),
        other => panic!("a stalled job was expected, not {other:?}"),
    }

    settle().await;
    let cancel = transport
        .emitted()
        .into_iter()
        .find(|frame| frame.channel == "job:cancel-requested")
        .expect("the cancellation was asked for");
    // The job that stalled, by its id: no other generation is touched.
    assert_eq!(cancel.payload, object(json!({ "jobId": "job-1" })));
}

#[tokio::test(start_paused = true)]
async fn a_generation_that_stalls_before_its_job_is_known_has_nothing_to_cancel() {
    // The knowledge base never answers the job's creation.
    let transport = FaultyTransport::answering(vec![FaultAction::DropReply], |_, _| Ok(None));
    let client = client_over(&transport);

    let seen = ended(collected(
        client
            .yield_
            .delegate(generation(None), Some(Duration::from_secs(5))),
    ))
    .await;

    assert_eq!(kinds(&seen), ["error job.stalled"]);
    settle().await;
    assert_eq!(asked(&transport, "job:cancel-requested"), 0);
}

#[tokio::test(start_paused = true)]
async fn a_status_of_cancelled_ends_the_follower_as_a_cancelled_job() {
    let (client, transport) = world();
    transport.queue_reply("job:status-requested", [status("cancelled", json!({}))]);
    let seen = ended(collected(highlighting(&client))).await;

    assert_eq!(kinds(&seen), ["error job.cancelled"]);
    match &seen[0] {
        Err(SemiontError::Job(cancelled)) => {
            assert_eq!(cancelled.message, "The job was cancelled");
            assert_eq!(cancelled.job_id.as_deref(), Some("job-1"));
        }
        other => panic!("a cancelled job was expected, not {other:?}"),
    }
    // It is asked about once: a cancelled job is over.
    assert_eq!(asked(&transport, "job:status-requested"), 1);
}

#[tokio::test(start_paused = true)]
async fn a_generations_setback_starts_its_stall_deadline_again_and_is_followed_past() {
    let (client, transport) = world();
    let started = Instant::now();
    let following = collected(
        client
            .yield_
            .delegate(generation(None), Some(Duration::from_secs(5))),
    );
    settle().await;

    // The attempt dies three seconds in, and the queue will try again.
    tokio::time::sleep(Duration::from_secs(3)).await;
    client.bus().emit(
        "job:fail",
        object(json!({
            "resourceId": "res-1", "jobId": "job-1", "jobType": "yield",
            "error": "a blip", "willRetry": true
        })),
        Envelope::default(),
    );

    // Past where the deadline would have fallen had the setback not been
    // heard: the next attempt has its whole deadline to say something, and
    // generation is not cancelled under it.
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert_eq!(asked(&transport, "job:cancel-requested"), 0);
    assert_eq!(asked(&transport, "job:status-requested"), 0);

    let seen = ended(following).await;
    assert_eq!(kinds(&seen), ["failed", "error job.stalled"]);
    let took = started.elapsed();
    assert!(
        took >= Duration::from_secs(8) && took < Duration::from_secs(9),
        "five seconds after the setback, not {took:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_generation_that_ends_in_time_is_not_cancelled() {
    let (client, transport) = world();
    let following = collected(
        client
            .yield_
            .delegate(generation(None), Some(Duration::from_secs(5))),
    );
    settle().await;
    client.bus().emit(
        "job:complete",
        object(json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": "yield" })),
        Envelope::default(),
    );
    let seen = ended(following).await;
    assert_eq!(kinds(&seen), ["complete"]);

    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(asked(&transport, "job:cancel-requested"), 0);
}

#[test]
fn how_long_a_generation_may_be_silent_grows_with_what_was_asked_of_it() {
    use semiont::timing::GENERATION_STALL_FLOOR;
    // Unstated, and short: the floor decides.
    assert_eq!(stall_deadline(None), GENERATION_STALL_FLOOR);
    assert_eq!(stall_deadline(Some(100.0)), GENERATION_STALL_FLOOR);
    // Long: the length does.
    assert_eq!(stall_deadline(Some(4000.0)), Duration::from_secs(300));
    assert_eq!(stall_deadline(Some(16_000.0)), Duration::from_secs(1200));
}

#[tokio::test(start_paused = true)]
async fn a_generation_waits_as_long_as_its_length_allows_when_no_deadline_is_stated() {
    let (client, _transport) = world();
    let started = Instant::now();
    let seen = ended(collected(
        client.yield_.delegate(generation(Some(4000)), None),
    ))
    .await;
    assert_eq!(
        kinds(&seen).last().map(String::as_str),
        Some("error job.stalled")
    );
    assert_eq!(started.elapsed().as_secs(), 300);
}

#[tokio::test]
async fn a_closed_client_delivers_nothing_and_refuses_what_is_asked_of_it() {
    let (client, _transport) = world();
    let mut signals = client.bus().frames("beckon:hover");
    client.close().await;
    client.close().await;

    assert_eq!(*client.state().borrow(), ConnectionState::Closed);
    assert!(client.bus().destroyed());
    assert_eq!(signals.next().await, None);

    client.beckon.hover(Some(&as_id("ann-1")));
    let refusal = client
        .frame
        .add_entity_type("Person")
        .await
        .expect_err("a closed client asks nothing");
    assert_eq!(refusal.code(), "bus.closed");
}
