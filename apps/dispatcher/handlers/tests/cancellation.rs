//! What a `job:cancel-requested` is answered with (docs/protocol/JOBS.md
//! § `job:cancel-requested`): whether the queue acted on the job it named.
//! A pending job is cancelled, and a running one is left to its worker,
//! which is accepted and not stopped.

mod support;

use semiont::types::Job;
use serde_json::{Value, json};

/// The job `job-1`, in `status`, with what that status states of it.
fn job(status: &str, more: Value) -> Job {
    let mut job = json!({
        "status": status,
        "metadata": {
            "id": "job-1",
            "type": "mark",
            "userId": "did:web:example.org:users:alice",
            "created": "2026-10-07T00:00:00.000Z",
            "retryCount": 0,
            "maxRetries": 1,
        },
        "params": { "resourceId": "res-1" },
    });
    for (key, value) in more.as_object().expect("an object") {
        job[key] = value.clone();
    }
    serde_json::from_value(job).expect("a job")
}

/// What a request to cancel `job-1` is answered with when the queue holds
/// `held`, and what the queue was asked.
async fn answered(held: Option<Job>) -> (Value, Vec<String>) {
    let (replies, asked) =
        support::handled(held, "job:cancel-requested", json!({ "jobId": "job-1" })).await;
    let [reply] = &replies[..] else {
        panic!("one reply, not {replies:?}");
    };
    assert_eq!(reply.channel, "job:cancel-ok");
    (Value::Object(reply.payload.clone()), asked)
}

fn acted(cancelled: bool) -> Value {
    json!({ "response": { "cancelled": cancelled } })
}

#[tokio::test]
async fn a_cancel_request_is_answered_with_whether_the_queue_acted_on_the_job() {
    assert_eq!(
        answered(None).await,
        (acted(false), vec!["get job-1".to_owned()])
    );

    let pending = job("pending", json!({}));
    assert_eq!(
        answered(Some(pending)).await,
        (
            acted(true),
            vec!["get job-1".to_owned(), "cancel job-1".to_owned()]
        )
    );

    // Its worker's to stop: the queue is asked nothing more.
    let running = job(
        "running",
        json!({ "startedAt": "2026-10-07T00:00:01.000Z", "progress": {} }),
    );
    assert_eq!(
        answered(Some(running)).await,
        (acted(true), vec!["get job-1".to_owned()])
    );

    let complete = job(
        "complete",
        json!({ "startedAt": "2026-10-07T00:00:01.000Z", "completedAt": "2026-10-07T00:00:02.000Z", "result": {} }),
    );
    assert_eq!(
        answered(Some(complete)).await,
        (acted(false), vec!["get job-1".to_owned()])
    );
}
