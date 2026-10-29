//! Completing a job below the bus (docs/protocol/JOBS.md § `job:complete`):
//! a completion is its verb's. Its result is stored in the one shape a
//! record keeps, whichever verb reported it; a completion whose result is
//! another verb's is not a completion at all; and one that is well formed
//! for another verb than the running job's leaves that job running.

mod support;

use semiont::types::Job;
use serde_json::{Value, json};

/// A job of `job_type`, running.
fn running(job_type: &str) -> Job {
    serde_json::from_value(json!({
        "status": "running",
        "metadata": {
            "id": "job-1",
            "type": job_type,
            "userId": "did:web:example.org:users:alice",
            "created": "2026-10-07T00:00:00.000Z",
            "retryCount": 0,
            "maxRetries": 1,
        },
        "params": { "resourceId": "res-1" },
        "startedAt": "2026-10-07T00:00:01.000Z",
        "progress": {},
    }))
    .expect("a running job")
}

fn completion(job_type: &str, result: Option<&Value>) -> Value {
    let mut completion = json!({ "resourceId": "res-1", "jobId": "job-1", "jobType": job_type });
    if let Some(result) = result {
        completion["result"] = result.clone();
    }
    completion
}

/// What the queue is asked when `completion` arrives for a running job of `held`.
async fn asked(held: &str, completion: Value) -> Vec<String> {
    let (replies, asked) = support::handled(Some(running(held)), "job:complete", completion).await;
    assert_eq!(replies, [], "job:complete is never answered");
    asked
}

fn counts() -> Value {
    json!({ "found": 4, "persisted": 3, "errors": 1 })
}

fn made() -> Value {
    json!({ "resourceId": "res-made", "resourceName": "Made", "truncated": false })
}

fn declined() -> Value {
    json!({ "declined": true, "reason": "no-text-layer" })
}

#[tokio::test]
async fn a_completion_of_the_jobs_verb_completes_it_with_its_result_as_a_record_stores_one() {
    for (verb, result) in [
        ("mark", counts()),
        ("mark", declined()),
        ("yield", made()),
        ("yield", declined()),
    ] {
        assert_eq!(
            asked(verb, completion(verb, Some(&result))).await,
            [
                "get job-1".to_owned(),
                format!("complete job-1 with {result}")
            ],
            "a {verb} job completed with {result}"
        );
    }
    // A completion that carries no result is stored with the empty one.
    for verb in ["mark", "yield"] {
        assert_eq!(
            asked(verb, completion(verb, None)).await,
            ["get job-1", "complete job-1 with {}"]
        );
    }
}

#[tokio::test]
async fn a_completion_of_another_verb_than_the_running_jobs_leaves_it_running() {
    for (held, completed_as, result) in [
        ("mark", "yield", Some(made())),
        ("mark", "yield", Some(declined())),
        ("mark", "yield", None),
        ("yield", "mark", Some(counts())),
        ("yield", "mark", Some(declined())),
        ("yield", "mark", None),
    ] {
        assert_eq!(
            asked(held, completion(completed_as, result.as_ref())).await,
            ["get job-1"],
            "a {held} job, and a {completed_as} completion with {result:?}"
        );
    }
}

/// The gateway refuses these before they are published. One that did not
/// pass a gateway does not decode, and the queue is asked nothing.
#[tokio::test]
async fn a_completion_whose_result_is_another_verbs_is_no_completion() {
    for (verb, result) in [
        ("mark", made()),
        ("yield", counts()),
        ("mark", json!({ "found": 4 })),
        (
            "yield",
            json!({ "highlightsFound": 4, "highlightsCreated": 3 }),
        ),
    ] {
        assert_eq!(
            asked(verb, completion(verb, Some(&result))).await,
            [] as [&str; 0],
            "a {verb} completion with {result}"
        );
    }
    assert_eq!(
        asked("mark", completion("annotation", None)).await,
        [] as [&str; 0]
    );
}
