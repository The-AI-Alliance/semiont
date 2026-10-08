//! What the handlers' tests below the bus share: a queue that records what
//! it was asked and holds at most one job, a knowledge base with no
//! vocabulary, and a frame handled over them.

use semiont::types::{
    BusFrame, FailureClass, Job, JobFilter, JobId, JobPending, JobStoredProgress, JobStoredResult,
    JobType, TagSchema,
};
use semiont_dispatcher_handlers::admission::{Refusal, Vocabulary};
use semiont_dispatcher_handlers::handlers::{Handlers, Reply};
use semiont_dispatcher_handlers::queue::{
    Checkpoint, Claim, FailOutcome, JobQueue, QueueError, Stats,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// A queue that records what it was asked. It answers a read with the job it
/// holds, when it holds one, and changes nothing.
struct AskedQueue {
    held: Option<Job>,
    asked: Mutex<Vec<String>>,
}

impl AskedQueue {
    fn note(&self, asked: String) {
        self.asked.lock().unwrap().push(asked);
    }
}

impl JobQueue for AskedQueue {
    async fn create_job(&self, job: JobPending) -> Result<(), QueueError> {
        self.note(format!("create for {}", job.params.resource_id));
        Ok(())
    }

    async fn get_job(&self, id: &JobId) -> Result<Option<Job>, QueueError> {
        self.note(format!("get {id}"));
        Ok(self.held.clone())
    }

    async fn claim_next_job(&self, accepts: &[JobFilter]) -> Result<Claim, QueueError> {
        self.note(format!("claim {}", json!(accepts)));
        Ok(Claim::Declined)
    }

    async fn complete_job(&self, id: &JobId, result: JobStoredResult) -> Result<bool, QueueError> {
        self.note(format!("complete {id} with {}", json!(result)));
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

    async fn cancel_pending_jobs(&self, job_type: JobType) -> Result<u64, QueueError> {
        self.note(format!("cancel every pending {}", job_type.as_str()));
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

/// What the handlers answer to `payload` on `channel` over a queue holding
/// `held`, and what they asked that queue.
pub async fn handled(
    held: Option<Job>,
    channel: &str,
    payload: Value,
) -> (Vec<Reply>, Vec<String>) {
    let queue = Arc::new(AskedQueue {
        held,
        asked: Mutex::new(Vec::new()),
    });
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
    let asked = queue.asked.lock().unwrap().clone();
    (replies, asked)
}
