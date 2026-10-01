//! The generated protocol types decode what the wire carries: each state of a
//! job, the empty object beside a progress report or a result, the params a
//! job's type adds, and the registry's operations.

use semiont::bus::operation;
use semiont::types::{Job, JobResult, JobStoredProgress, JobStoredResult};
use serde_json::{Value, json};

fn metadata() -> Value {
    json!({
        "id": "job-0123456789abcdef0123456789abcdef",
        "type": "highlight-annotation",
        "userId": "did:web:example.org:users:alice",
        "created": "2026-09-30T12:00:00.000Z",
        "retryCount": 0,
        "maxRetries": 1
    })
}

fn params() -> Value {
    json!({ "resourceId": "res-1", "density": 3, "instructions": "be brief" })
}

#[test]
fn a_claimed_job_is_running_with_no_progress_yet_and_keeps_its_params() {
    let wire = json!({
        "status": "running",
        "metadata": metadata(),
        "params": params(),
        "startedAt": "2026-09-30T12:00:01.000Z",
        "progress": {}
    });
    let Job::Running(job) = serde_json::from_value(wire.clone()).expect("a running job decodes")
    else {
        panic!("a running job decoded as another state");
    };
    assert!(matches!(job.progress, JobStoredProgress::Empty(_)));
    assert_eq!(job.params.resource_id, "res-1");
    assert_eq!(job.params.rest["density"], json!(3));
    assert_eq!(
        serde_json::to_value(Job::Running(job)).expect("it encodes"),
        wire
    );
}

#[test]
fn a_reported_progress_is_a_report_not_the_empty_object() {
    let progress: JobStoredProgress =
        serde_json::from_value(json!({ "percentage": 40, "message": { "code": "analyzing" } }))
            .expect("a report decodes");
    assert!(matches!(progress, JobStoredProgress::JobProgress(_)));
}

#[test]
fn a_completed_job_carries_its_result_or_the_empty_object() {
    let complete = |result: Value| {
        json!({
            "status": "complete",
            "metadata": metadata(),
            "params": params(),
            "startedAt": "2026-09-30T12:00:01.000Z",
            "completedAt": "2026-09-30T12:00:02.000Z",
            "result": result
        })
    };
    let Job::Complete(reported) = serde_json::from_value(complete(json!({
        "kind": "highlight-annotation", "highlightsFound": 2, "highlightsCreated": 2
    })))
    .expect("a completed job decodes") else {
        panic!("a completed job decoded as another state");
    };
    assert!(matches!(
        reported.result,
        JobStoredResult::JobResult(JobResult::HighlightAnnotationResult(_))
    ));
    let Job::Complete(bare) = serde_json::from_value(complete(json!({}))).expect("it decodes")
    else {
        panic!("a completed job decoded as another state");
    };
    assert!(matches!(bare.result, JobStoredResult::Empty(_)));
}

#[test]
fn each_state_decodes_as_itself() {
    let base = |status: &str, extra: Value| {
        let mut job = json!({ "status": status, "metadata": metadata(), "params": params() });
        job.as_object_mut()
            .expect("an object")
            .extend(extra.as_object().expect("an object").clone());
        serde_json::from_value::<Job>(job).expect("the job decodes")
    };
    assert!(matches!(base("pending", json!({})), Job::Pending(_)));
    assert!(matches!(
        base(
            "failed",
            json!({ "completedAt": "2026-09-30T12:00:02.000Z", "error": "broken" })
        ),
        Job::Failed(_)
    ));
    assert!(matches!(
        base(
            "cancelled",
            json!({ "completedAt": "2026-09-30T12:00:02.000Z" })
        ),
        Job::Cancelled(_)
    ));
}

#[test]
fn a_job_of_a_state_the_protocol_does_not_have_does_not_decode() {
    let wire = json!({ "status": "claimed", "metadata": metadata(), "params": params() });
    assert!(serde_json::from_value::<Job>(wire).is_err());
}

#[test]
fn the_registry_names_each_operation_its_reply_and_its_failure() {
    let claim = operation("job:claim").expect("job:claim is an operation");
    assert_eq!(
        (claim.result, claim.failure),
        ("job:claimed", "job:claim-failed")
    );
    assert!(
        operation("job:complete").is_none(),
        "job:complete is not answered"
    );
}
