//! A frame carrying an id its kind refuses (docs/protocol/JOBS.md § Channels):
//! it does not decode, so a request is answered on its failure channel, a
//! one-way command is dropped, and the queue is never asked anything. The
//! gateway refuses such a payload before it is published, so only a frame
//! that did not pass a gateway carries one, and only a test below the bus can
//! send it. Each case has its control: the same frame with ids that pass
//! reaches the queue, so a silent queue is the handler's doing.

mod support;

use semiont_dispatcher_handlers::handlers::Reply;
use serde_json::{Value, json};

const ALICE: &str = "did:web:example.org:users:alice";

/// What the handlers answer to `payload` on `channel`, and what they asked a
/// queue that holds nothing.
async fn handled(channel: &str, payload: Value) -> (Vec<Reply>, Vec<String>) {
    support::handled(None, channel, payload).await
}

/// The one reply, on `channel`, correlated; its message.
fn refusal(replies: &[Reply], channel: &str) -> String {
    let [reply] = replies else {
        panic!("one reply, not {replies:?}");
    };
    assert_eq!(reply.channel, channel);
    assert_eq!(reply.correlation_id.as_deref(), Some("c1"));
    reply.payload["message"]
        .as_str()
        .expect("a failure has a message")
        .to_owned()
}

fn create(resource_id: &str, user_id: &str) -> Value {
    json!({
        "jobType": "mark",
        "resourceId": resource_id,
        "params": { "motivation": "highlighting" },
        "_userId": user_id,
    })
}

#[tokio::test]
async fn a_create_for_a_resource_id_that_is_not_one_is_refused_and_queues_nothing() {
    let (replies, asked) = handled("job:create", create("..", ALICE)).await;
    let message = refusal(&replies, "job:create-failed");
    assert!(
        message.starts_with("a job:create that is not a JobCreateCommand: ")
            && message.contains("ResourceId"),
        "{message}"
    );
    assert_eq!(asked, [] as [&str; 0]);

    let (replies, asked) = handled("job:create", create("r1", ALICE)).await;
    assert_eq!(replies[0].channel, "job:created");
    assert_eq!(asked, ["create for r1"]);
}

#[tokio::test]
async fn a_create_by_a_user_id_that_is_not_a_did_is_refused_and_queues_nothing() {
    let (replies, asked) = handled("job:create", create("r1", "alice")).await;
    let message = refusal(&replies, "job:create-failed");
    assert!(
        message.starts_with("a job:create that is not a JobCreateCommand: ")
            && message.contains("UserId"),
        "{message}"
    );
    assert_eq!(asked, [] as [&str; 0]);
}

#[tokio::test]
async fn a_claim_by_a_user_id_that_is_not_a_did_is_refused_before_the_queue_is_asked() {
    let claim = |user_id: &str| json!({ "accepts": [{ "jobType": "yield" }], "_roles": ["semiont-worker"], "_userId": user_id });
    let (replies, asked) = handled("job:claim", claim("")).await;
    let message = refusal(&replies, "job:claim-failed");
    assert!(
        message.starts_with("a job:claim that is not a JobClaimCommand: "),
        "{message}"
    );
    assert_eq!(asked, [] as [&str; 0]);

    let (_, asked) = handled("job:claim", claim(ALICE)).await;
    assert_eq!(asked, [r#"claim [{"jobType":"yield"}]"#]);
}

#[tokio::test]
async fn a_one_way_command_for_a_job_id_that_is_not_one_is_dropped() {
    // Each command, and what it asks the queue of a job whose id passes: a
    // completion reads the job before it completes it.
    let commands: [(&str, Value, &[&str]); 5] = [
        (
            "job:complete",
            json!({ "resourceId": "r1", "jobType": "mark" }),
            &["get job-1", "complete job-1 with {}"],
        ),
        (
            "job:fail",
            json!({ "resourceId": "r1", "jobType": "mark", "error": "it broke" }),
            &["fail job-1"],
        ),
        (
            "job:report-progress",
            json!({ "resourceId": "r1", "jobType": "mark", "percentage": 50 }),
            &["progress job-1"],
        ),
        (
            "job:checkpoint",
            json!({ "completedUnits": ["u1"] }),
            &["checkpoint job-1"],
        ),
        (
            "job:cancel",
            json!({ "resourceId": "r1", "jobType": "mark" }),
            &["cancel job-1"],
        ),
    ];
    for (channel, rest, asks) in commands {
        let with = |job_id: &str| {
            let mut payload = rest.clone();
            payload["jobId"] = json!(job_id);
            payload
        };
        let (replies, asked) = handled(channel, with("a b")).await;
        assert_eq!(replies, [], "{channel} is never answered");
        assert_eq!(asked, [] as [&str; 0], "{channel} for `a b`");

        let (replies, asked) = handled(channel, with("job-1")).await;
        assert_eq!(replies, [], "{channel} is never answered");
        assert_eq!(asked, asks, "{channel} for `job-1`");
    }
}

/// An empty `jobId` beside a `jobType` is refused. Read as no id at all, it
/// would cancel every pending job of the type.
#[tokio::test]
async fn a_cancel_request_with_an_empty_job_id_and_a_type_cancels_nothing() {
    let (replies, asked) = handled(
        "job:cancel-requested",
        json!({ "jobId": "", "jobType": "mark" }),
    )
    .await;
    let message = refusal(&replies, "job:cancel-failed");
    assert!(
        message.starts_with("a job:cancel-requested that is not a JobCancelRequest: "),
        "{message}"
    );
    assert_eq!(asked, [] as [&str; 0]);

    let (replies, asked) = handled("job:cancel-requested", json!({ "jobType": "mark" })).await;
    assert_eq!(replies[0].channel, "job:cancel-ok");
    assert_eq!(asked, ["cancel every pending mark"]);
}

#[tokio::test]
async fn a_status_request_for_a_job_id_that_is_not_one_is_refused_before_the_queue_is_asked() {
    let (replies, asked) = handled("job:status-requested", json!({ "jobId": "a/b" })).await;
    let message = refusal(&replies, "job:status-failed");
    assert!(
        message.starts_with("a job:status-requested that is not a JobStatusRequest: "),
        "{message}"
    );
    assert_eq!(asked, [] as [&str; 0]);

    let (replies, asked) = handled("job:status-requested", json!({ "jobId": "job-1" })).await;
    assert_eq!(refusal(&replies, "job:status-failed"), "Job not found");
    assert_eq!(asked, ["get job-1"]);
}
