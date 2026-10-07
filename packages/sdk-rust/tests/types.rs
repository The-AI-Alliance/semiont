//! The generated protocol types decode what the wire carries: each state of a
//! job, the empty object beside a progress report or a result, the params a
//! job is held with, a job description and the three results a job reports,
//! and the registry's operations.

use semiont::bus::operation;
use semiont::types::{
    HighlightingJobParams, Job, JobCreateCommand, JobFilter, JobQueuedEvent, JobResult,
    JobStoredProgress, JobStoredResult, LinkingJobParams, MarkJobCreateCommand, MarkJobFilter,
    MarkJobFilterParams, MarkJobParams, Motivation, TaggingJobParams, YieldJobFilter,
};
use serde_json::{Value, json};

fn metadata() -> Value {
    json!({
        "id": "job-0123456789abcdef0123456789abcdef",
        "type": "mark",
        "userId": "did:web:example.org:users:alice",
        "created": "2026-09-30T12:00:00.000Z",
        "retryCount": 0,
        "maxRetries": 1
    })
}

fn params() -> Value {
    json!({ "resourceId": "res-1", "motivation": "highlighting", "density": 3, "instructions": "be brief" })
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
    let Job::Complete(reported) =
        serde_json::from_value(complete(json!({ "found": 2, "persisted": 2 })))
            .expect("a completed job decodes")
    else {
        panic!("a completed job decoded as another state");
    };
    assert!(matches!(
        reported.result,
        JobStoredResult::JobResult(JobResult::DetectionResult(_))
    ));
    let Job::Complete(bare) = serde_json::from_value(complete(json!({}))).expect("it decodes")
    else {
        panic!("a completed job decoded as another state");
    };
    assert!(matches!(bare.result, JobStoredResult::Empty(_)));
}

/// The three results share no member, and each is closed: a result is told
/// from the others by what it alone carries, and one that mixes them, or
/// carries anything else, is none.
#[test]
fn a_result_is_one_of_three_told_apart_by_what_each_alone_carries() {
    let result = |wire: Value| serde_json::from_value::<JobResult>(wire);
    let detection = result(json!({
        "found": 7, "persisted": 5, "errors": 2, "byCategory": { "Issue": 3, "Rule": 2 }, "underReportedPieces": 1
    }))
    .expect("a mark job's counts decode");
    let JobResult::DetectionResult(counts) = &detection else {
        panic!("counts decoded as {detection:?}");
    };
    assert_eq!(
        (
            counts.found,
            counts.persisted,
            counts.errors,
            counts.under_reported_pieces
        ),
        (7, 5, Some(2), Some(1))
    );
    assert!(matches!(
        result(json!({ "resourceId": "res-made", "resourceName": "Made", "truncated": false })),
        Ok(JobResult::GenerationResult(_))
    ));
    assert!(matches!(
        result(json!({ "declined": true, "reason": "no-text-layer" })),
        Ok(JobResult::DeclinedResult(_))
    ));

    for none in [
        json!({ "highlightsFound": 2, "highlightsCreated": 2 }),
        json!({ "kind": "highlight-annotation", "found": 2, "persisted": 2 }),
        json!({ "found": 2, "persisted": 2, "resourceId": "res-made", "resourceName": "Made", "truncated": false }),
        json!({ "found": 2, "persisted": 2, "declined": true, "reason": "empty" }),
        json!({ "found": 2 }),
    ] {
        assert!(result(none.clone()).is_err(), "{none} decoded as a result");
    }
}

/// A job description is told apart by a property, and a value is decoded as
/// the member that property names: what is wrong with it is said of that
/// member.
#[test]
fn a_job_description_decodes_as_the_member_its_job_type_and_motivation_name() {
    let command: JobCreateCommand = serde_json::from_value(json!({
        "jobType": "mark", "resourceId": "res-1",
        "params": { "motivation": "tagging", "schemaId": "irac", "categories": ["Issue"] },
    }))
    .expect("a mark job's description decodes");
    assert_eq!(
        command,
        MarkJobCreateCommand::new(
            "res-1".parse().expect("a resource id"),
            TaggingJobParams::new("irac", vec!["Issue".to_owned()]).into(),
        )
        .into()
    );
    assert_eq!(
        serde_json::to_value(MarkJobParams::from(HighlightingJobParams::new()))
            .expect("it encodes"),
        json!({ "motivation": "highlighting" })
    );

    let refused = |params: Value| {
        serde_json::from_value::<MarkJobParams>(params)
            .expect_err("it is no job's parameters")
            .to_string()
    };
    let not_taken =
        refused(json!({ "motivation": "linking", "entityTypes": ["Person"], "instructions": "x" }));
    assert!(
        not_taken.contains("unknown field `instructions`"),
        "{not_taken}"
    );
    let missing = refused(json!({ "motivation": "tagging", "categories": ["Issue"] }));
    assert!(missing.contains("missing field `schemaId`"), "{missing}");
    let unnamed = refused(json!({ "motivation": "bookmarking" }));
    assert!(
        unnamed.contains("`highlighting`, `commenting`, `assessing`, `linking`, `tagging`"),
        "{unnamed}"
    );
    assert!(
        serde_json::from_value::<JobCreateCommand>(json!({
            "jobType": "yield", "resourceId": "res-1", "params": {},
        }))
        .is_err()
    );
}

#[test]
fn an_announcement_and_a_filter_decode_as_the_member_their_job_type_names() {
    let announced: JobQueuedEvent = serde_json::from_value(json!({
        "jobId": "job-1", "jobType": "mark", "resourceId": "res-1",
        "userId": "did:web:example.org:users:alice",
        "params": { "motivation": "linking", "entityTypes": ["Person"] },
    }))
    .expect("an announcement decodes");
    let JobQueuedEvent::MarkJobQueuedEvent(mark) = &announced else {
        panic!("a mark job's announcement decoded as {announced:?}");
    };
    assert_eq!(
        mark.params,
        LinkingJobParams::new(vec!["Person".to_owned()]).into()
    );

    let filters: Vec<JobFilter> = serde_json::from_value(json!([
        { "jobType": "mark", "params": { "motivation": "tagging" } },
        { "jobType": "yield" },
    ]))
    .expect("filters decode");
    assert_eq!(
        filters,
        [
            MarkJobFilter::new(MarkJobFilterParams {
                motivation: Motivation::Tagging
            })
            .into(),
            YieldJobFilter::new().into(),
        ]
    );
    // A mark filter always states its motivation.
    assert!(serde_json::from_value::<JobFilter>(json!({ "jobType": "mark" })).is_err());
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
