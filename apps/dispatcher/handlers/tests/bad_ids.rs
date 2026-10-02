//! A frame carrying an id its kind refuses (docs/protocol/JOBS.md § Channels):
//! it does not decode, so a request is answered on its failure channel, a
//! one-way command is dropped, and the queue is never asked anything. The
//! gateway refuses such a payload before it is published, so only a frame
//! that did not pass a gateway carries one, and only a test below the bus can
//! send it. Each case has its control: the same frame with ids that pass
//! reaches the queue, so a silent queue is the handler's doing.

use semiont::types::{
    BusFrame, FailureClass, Job, JobCancelRequestJobType, JobId, JobPending, JobStoredProgress,
    JobStoredResult, TagSchema,
};
use semiont_dispatcher_handlers::admission::{Refusal, Vocabulary};
use semiont_dispatcher_handlers::handlers::{Handlers, Reply};
use semiont_dispatcher_handlers::queue::{
    Checkpoint, Claim, FailOutcome, JobQueue, QueueError, Stats,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// A queue that holds nothing and records what it was asked.
#[derive(Default)]
struct AskedQueue {
    asked: Mutex<Vec<String>>,
}

impl AskedQueue {
    fn note(&self, asked: String) {
        self.asked.lock().unwrap().push(asked);
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

impl JobQueue for AskedQueue {
    async fn create_job(&self, job: JobPending) -> Result<(), QueueError> {
        self.note(format!("create for {}", job.params.resource_id));
        Ok(())
    }

    async fn get_job(&self, id: &JobId) -> Result<Option<Job>, QueueError> {
        self.note(format!("get {id}"));
        Ok(None)
    }

    async fn claim_next_job(&self, types: &[String]) -> Result<Claim, QueueError> {
        self.note(format!("claim {types:?}"));
        Ok(Claim::Declined)
    }

    async fn complete_job(&self, id: &JobId, _result: JobStoredResult) -> Result<bool, QueueError> {
        self.note(format!("complete {id}"));
        Ok(true)
    }

    async fn fail_job(
        &self,
        id: &JobId,
        _error: String,
        _checkpoint: Checkpoint,
        _failure_class: Option<FailureClass>,
    ) -> Result<Option<FailOutcome>, QueueError> {
        self.note(format!("fail {id}"));
        Ok(Some(FailOutcome::Failed))
    }

    async fn checkpoint_units(
        &self,
        id: &JobId,
        _checkpoint: Checkpoint,
    ) -> Result<(), QueueError> {
        self.note(format!("checkpoint {id}"));
        Ok(())
    }

    async fn record_progress(
        &self,
        id: &JobId,
        _progress: JobStoredProgress,
    ) -> Result<(), QueueError> {
        self.note(format!("progress {id}"));
        Ok(())
    }

    async fn cancel_pending_jobs(
        &self,
        category: JobCancelRequestJobType,
    ) -> Result<u64, QueueError> {
        self.note(format!("cancel every pending {category:?}"));
        Ok(0)
    }

    async fn cancel_job(&self, id: &JobId) -> Result<bool, QueueError> {
        self.note(format!("cancel {id}"));
        Ok(true)
    }

    async fn stats(&self) -> Result<Stats, QueueError> {
        self.note("stats".to_owned());
        Ok(Stats::default())
    }
}

/// A knowledge base with no vocabulary; none of these jobs reads it.
struct NoVocabulary;

impl Vocabulary for NoVocabulary {
    async fn entity_types(&self) -> Result<Vec<String>, Refusal> {
        Ok(Vec::new())
    }

    async fn tag_schemas(&self) -> Result<Vec<TagSchema>, Refusal> {
        Ok(Vec::new())
    }
}

const ALICE: &str = "did:web:example.org:users:alice";

/// What the handlers answer to `payload` on `channel`, and what they asked the queue.
async fn handled(channel: &str, payload: Value) -> (Vec<Reply>, Vec<String>) {
    let queue = Arc::new(AskedQueue::default());
    let handlers = Handlers::new(queue.clone(), Arc::new(NoVocabulary));
    let Value::Object(payload) = payload else {
        panic!("a payload is an object");
    };
    let replies = handlers
        .handle(BusFrame {
            channel: channel.to_owned(),
            correlation_id: Some("c1".to_owned()),
            payload,
            scope: None,
        })
        .await;
    (replies, queue.asked())
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
        "jobType": "highlight-annotation",
        "resourceId": resource_id,
        "params": {},
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
    let claim =
        |user_id: &str| json!({ "types": [], "_roles": ["semiont-worker"], "_userId": user_id });
    let (replies, asked) = handled("job:claim", claim("")).await;
    let message = refusal(&replies, "job:claim-failed");
    assert!(
        message.starts_with("a job:claim that is not a JobClaimCommand: "),
        "{message}"
    );
    assert_eq!(asked, [] as [&str; 0]);

    let (_, asked) = handled("job:claim", claim(ALICE)).await;
    assert_eq!(asked, ["claim []"]);
}

#[tokio::test]
async fn a_one_way_command_for_a_job_id_that_is_not_one_is_dropped() {
    let commands = [
        (
            "job:complete",
            json!({ "resourceId": "r1", "jobType": "highlight-annotation" }),
            "complete",
        ),
        (
            "job:fail",
            json!({ "resourceId": "r1", "jobType": "highlight-annotation", "error": "it broke" }),
            "fail",
        ),
        (
            "job:report-progress",
            json!({ "resourceId": "r1", "jobType": "highlight-annotation", "percentage": 50 }),
            "progress",
        ),
        (
            "job:checkpoint",
            json!({ "completedUnits": ["u1"] }),
            "checkpoint",
        ),
        (
            "job:cancel",
            json!({ "resourceId": "r1", "jobType": "highlight-annotation" }),
            "cancel",
        ),
    ];
    for (channel, rest, verb) in commands {
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
        assert_eq!(asked, [format!("{verb} job-1")], "{channel} for `job-1`");
    }
}

/// An empty `jobId` beside a `jobType` is refused. Read as no id at all, it
/// would cancel every pending job of the category.
#[tokio::test]
async fn a_cancel_request_with_an_empty_job_id_and_a_category_cancels_nothing() {
    let (replies, asked) = handled(
        "job:cancel-requested",
        json!({ "jobId": "", "jobType": "annotation" }),
    )
    .await;
    let message = refusal(&replies, "job:cancel-failed");
    assert!(
        message.starts_with("a job:cancel-requested that is not a JobCancelRequest: "),
        "{message}"
    );
    assert_eq!(asked, [] as [&str; 0]);

    let (replies, asked) =
        handled("job:cancel-requested", json!({ "jobType": "annotation" })).await;
    assert_eq!(replies[0].channel, "job:cancel-ok");
    assert_eq!(asked, ["cancel every pending Annotation"]);
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
