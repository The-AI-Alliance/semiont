//! The nine channels the dispatcher answers (JOBS.md § Channels): each frame
//! decoded as its channel's command, acted on through the queue, and answered
//! with the replies it owes — the operation's result or failure, carrying the
//! request's correlation id, and for a claim the dispatcher's own record of it.
//! Frames are not serialized: each is handled as it comes, and the queue's
//! atomic transitions settle any race between two.

use crate::admission::{Refusal, Vocabulary, admit};
use crate::queue::{Checkpoint, Claim, FailOutcome, JobQueue, QueueError};
use semiont::channels::{
    Channel, JobAssign, JobCancel, JobCancelRequested, JobCheckpoint, JobClaim, JobComplete,
    JobCreate, JobFail, JobReportProgress, JobStatusRequested, Request,
};
use semiont::roles::WORKER_ROLE;
use semiont::types::{
    BusFrame, CommandError, CommandErrorCode, Job, JobAssignCommand, JobCancelCommand,
    JobCancelRequest, JobCheckpointCommand, JobClaimCommand, JobClaimedResult, JobCompleteCommand,
    JobCreatedResult, JobCreatedResultResponse, JobFailCommand, JobId, JobProgress,
    JobReportProgressCommand, JobResult, JobStatusRequest, JobStatusResponse,
    JobStatusResponseStatus, JobStatusResult, JobStoredProgress, JobStoredResult, MarkJobResult,
    YieldJobResult,
};
use semiont_observability::logging;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use std::sync::Arc;

/// The channels the dispatcher subscribes to and answers. Each is named, here
/// and in `handle`, by its type, which exists only for a channel the bus
/// registry declares. `lint:spec-channel-rosters` holds the two to each other
/// and to JOBS.md § Channels.
pub const COMMANDS: [&str; 9] = [
    JobCreate::NAME,
    JobClaim::NAME,
    JobComplete::NAME,
    JobFail::NAME,
    JobReportProgress::NAME,
    JobCheckpoint::NAME,
    JobCancelRequested::NAME,
    JobCancel::NAME,
    JobStatusRequested::NAME,
];

/// A frame the dispatcher sends in answer: on `channel`, correlated when it
/// answers a request.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub channel: &'static str,
    pub payload: Map<String, Value>,
    pub correlation_id: Option<String>,
}

fn object(value: &impl Serialize) -> Map<String, Value> {
    match serde_json::to_value(value) {
        Ok(Value::Object(fields)) => fields,
        _ => unreachable!("a reply payload serializes as an object"),
    }
}

fn failure(message: impl Into<String>, code: Option<CommandErrorCode>) -> Map<String, Value> {
    object(&CommandError {
        code,
        message: message.into(),
        details: None,
    })
}

fn component() -> Value {
    json!({ "component": "handlers" })
}

fn fields(extra: Value) -> Value {
    let mut all = component();
    if let (Some(all), Some(extra)) = (all.as_object_mut(), extra.as_object()) {
        all.extend(extra.clone());
    }
    all
}

pub struct Handlers<Q: JobQueue, V: Vocabulary> {
    queue: Arc<Q>,
    reads: Arc<V>,
}

impl<Q: JobQueue, V: Vocabulary> Handlers<Q, V> {
    pub fn new(queue: Arc<Q>, reads: Arc<V>) -> Handlers<Q, V> {
        Handlers { queue, reads }
    }

    /// Handle one frame of a channel in `COMMANDS`; answer the replies it owes, in order.
    pub async fn handle(&self, frame: BusFrame) -> Vec<Reply> {
        let correlation_id = frame.correlation_id.clone();
        let channel = frame.channel.as_str();
        let payload = Value::Object(frame.payload);
        match channel {
            JobCreate::NAME => self.create(payload, correlation_id).await,
            JobClaim::NAME => self.claim(payload, correlation_id).await,
            JobComplete::NAME => self.signal(payload, channel, |c| self.complete(c)).await,
            JobFail::NAME => self.signal(payload, channel, |c| self.fail(c)).await,
            JobReportProgress::NAME => {
                self.signal(payload, channel, |c| self.report_progress(c))
                    .await
            }
            JobCheckpoint::NAME => self.signal(payload, channel, |c| self.checkpoint(c)).await,
            JobCancelRequested::NAME => self.cancel_requested(payload, correlation_id).await,
            JobCancel::NAME => self.signal(payload, channel, |c| self.cancel(c)).await,
            JobStatusRequested::NAME => self.status(payload, correlation_id).await,
            other => {
                logging::warn(
                    "A frame on a channel the dispatcher does not answer",
                    fields(json!({ "channel": other })),
                );
                Vec::new()
            }
        }
    }

    /// A one-way command: decoded, acted on, never answered.
    async fn signal<C: DeserializeOwned, F: Future<Output = ()>>(
        &self,
        payload: Value,
        channel: &str,
        act: impl FnOnce(C) -> F,
    ) -> Vec<Reply> {
        match serde_json::from_value::<C>(payload) {
            Ok(command) => act(command).await,
            Err(error) => logging::warn(
                "A command that does not decode",
                fields(json!({ "channel": channel, "error": error.to_string() })),
            ),
        }
        Vec::new()
    }

    async fn create(&self, payload: Value, correlation_id: Option<String>) -> Vec<Reply> {
        let refused = |refusal: Refusal| {
            logging::error(
                "job:create failed",
                fields(json!({ "correlationId": correlation_id, "error": refusal.message })),
            );
            vec![Reply {
                channel: <<JobCreate as Request>::Failure as Channel>::NAME,
                payload: failure(refusal.message, refusal.code),
                correlation_id: correlation_id.clone(),
            }]
        };
        let job = match admit(payload, self.reads.as_ref()).await {
            Ok(job) => job,
            Err(refusal) => return refused(refusal),
        };
        let id = job.metadata.id.clone();
        let job_type = job.metadata.r#type;
        if let Err(error) = self.queue.create_job(job).await {
            return refused(Refusal::new(error.0));
        }
        logging::info(
            "Job created via bus",
            fields(
                json!({ "jobId": id, "jobType": job_type.as_str(), "correlationId": correlation_id }),
            ),
        );
        vec![Reply {
            channel: <<JobCreate as Request>::Result as Channel>::NAME,
            payload: object(&JobCreatedResult {
                response: JobCreatedResultResponse { job_id: id },
            }),
            correlation_id,
        }]
    }

    async fn claim(&self, payload: Value, correlation_id: Option<String>) -> Vec<Reply> {
        let refused = |message: String, code: Option<CommandErrorCode>| {
            vec![Reply {
                channel: <<JobClaim as Request>::Failure as Channel>::NAME,
                payload: failure(message, code),
                correlation_id: correlation_id.clone(),
            }]
        };
        let command: JobClaimCommand = match serde_json::from_value(payload) {
            Ok(command) => command,
            Err(error) => {
                return refused(
                    format!("a job:claim that is not a JobClaimCommand: {error}"),
                    None,
                );
            }
        };
        let worker = command
            ._roles
            .as_deref()
            .is_some_and(|roles| roles.iter().any(|r| r == WORKER_ROLE));
        if !worker {
            return refused(
                "job:claim refused: the caller is not a worker for this knowledge base".to_owned(),
                Some(CommandErrorCode::Unauthorized),
            );
        }
        let job = match self.queue.claim_next_job(&command.accepts).await {
            Ok(Claim::Claimed(job)) => job,
            Ok(Claim::Declined) => {
                return refused(
                    "No pending job matches the claim".to_owned(),
                    Some(CommandErrorCode::NonePending),
                );
            }
            Err(error) => return refused(error.0, None),
        };
        let Some(holder) = command._user_id else {
            return refused(
                "job:claim missing _userId (gateway injection)".to_owned(),
                None,
            );
        };
        let assignment = JobAssignCommand {
            _user_id: None,
            job_id: job.metadata.id.clone(),
            job_type: job.metadata.r#type,
            resource_id: job.params.resource_id.clone(),
            holder,
            requester: job.metadata.user_id.clone(),
        };
        vec![
            Reply {
                channel: <<JobClaim as Request>::Result as Channel>::NAME,
                payload: object(&JobClaimedResult { response: *job }),
                correlation_id,
            },
            Reply {
                channel: JobAssign::NAME,
                payload: object(&assignment),
                correlation_id: None,
            },
        ]
    }

    async fn complete(&self, command: JobCompleteCommand) {
        let (job_id, completed_as, result) = concluded(command);
        let unsynced = |error: QueueError| {
            logging::error(
                "Failed to sync job completion to queue",
                fields(json!({ "jobId": job_id, "error": error.0 })),
            );
        };
        // A completion is its verb's. One of another verb than the running
        // job's is not that job's completion, and the job stays running.
        match self.queue.get_job(&job_id).await {
            Ok(Some(Job::Running(job))) if job.metadata.r#type.as_str() != completed_as => {
                return logging::warn(
                    "job:complete of another verb than the job's",
                    fields(json!({
                        "jobId": job_id,
                        "jobType": job.metadata.r#type.as_str(),
                        "completedAs": completed_as,
                    })),
                );
            }
            Ok(_) => {}
            Err(error) => return unsynced(error),
        }
        match self.queue.complete_job(&job_id, result).await {
            Ok(true) => {}
            Ok(false) => logging::warn(
                "job:complete for a job not in running",
                fields(json!({ "jobId": job_id })),
            ),
            Err(error) => unsynced(error),
        }
    }

    async fn fail(&self, command: JobFailCommand) {
        let checkpoint = Checkpoint {
            completed_units: command.completed_units.unwrap_or_default(),
            unit_cursors: command.unit_cursors,
        };
        match self
            .queue
            .fail_job(
                &command.job_id,
                command.error,
                checkpoint,
                command.failure_class,
            )
            .await
        {
            Ok(Some(FailOutcome::Retried)) => {
                logging::info(
                    "Job re-queued for retry",
                    fields(json!({ "jobId": command.job_id })),
                );
            }
            Ok(Some(FailOutcome::Failed)) => {}
            Ok(None) => logging::warn(
                "job:fail for a job not in running",
                fields(json!({ "jobId": command.job_id })),
            ),
            Err(error) => logging::error(
                "Failed to sync job failure to queue",
                fields(json!({ "jobId": command.job_id, "error": error.0 })),
            ),
        }
    }

    async fn report_progress(&self, command: JobReportProgressCommand) {
        let progress = match command.progress {
            Some(progress) => progress,
            None => match serde_json::from_value::<JobProgress>(
                json!({ "percentage": command.percentage }),
            ) {
                Ok(progress) => progress,
                Err(error) => {
                    logging::error(
                        "A bare percentage that is not a progress report",
                        fields(json!({ "jobId": command.job_id, "error": error.to_string() })),
                    );
                    return;
                }
            },
        };
        if let Err(error) = self
            .queue
            .record_progress(&command.job_id, JobStoredProgress::JobProgress(progress))
            .await
        {
            logging::error(
                "Failed to record job progress",
                fields(json!({ "jobId": command.job_id, "error": error.0 })),
            );
        }
    }

    async fn checkpoint(&self, command: JobCheckpointCommand) {
        let checkpoint = Checkpoint {
            completed_units: command.completed_units,
            unit_cursors: command.unit_cursors,
        };
        if let Err(error) = self
            .queue
            .checkpoint_units(&command.job_id, checkpoint)
            .await
        {
            logging::error(
                "Failed to checkpoint job units",
                fields(json!({ "jobId": command.job_id, "error": error.0 })),
            );
        }
    }

    async fn cancel(&self, command: JobCancelCommand) {
        match self.queue.cancel_job(&command.job_id).await {
            Ok(_) => logging::info(
                "Job cancelled by its worker",
                fields(json!({ "jobId": command.job_id })),
            ),
            Err(error) => logging::error(
                "Failed to cancel job",
                fields(json!({ "jobId": command.job_id, "error": error.0 })),
            ),
        }
    }

    async fn cancel_requested(&self, payload: Value, correlation_id: Option<String>) -> Vec<Reply> {
        let answer = |cancelled: Result<u64, String>| {
            let (channel, payload) = match cancelled {
                Ok(cancelled) => (
                    <<JobCancelRequested as Request>::Result as Channel>::NAME,
                    object(&json!({ "response": { "cancelled": cancelled } })),
                ),
                Err(message) => (
                    <<JobCancelRequested as Request>::Failure as Channel>::NAME,
                    failure(message, None),
                ),
            };
            vec![Reply {
                channel,
                payload,
                correlation_id: correlation_id.clone(),
            }]
        };
        let request: JobCancelRequest = match serde_json::from_value(payload) {
            Ok(request) => request,
            Err(error) => {
                return answer(Err(format!(
                    "a job:cancel-requested that is not a JobCancelRequest: {error}"
                )));
            }
        };
        let cancelled = match (request.job_id, request.job_type) {
            (Some(id), _) => self.cancel_one(&id).await,
            (None, Some(job_type)) => {
                let cancelled = self
                    .queue
                    .cancel_pending_jobs(job_type)
                    .await
                    .map_err(|e| e.0);
                if let Ok(count) = cancelled {
                    logging::info(
                        "Cancel requested",
                        fields(json!({ "jobType": job_type.as_str(), "cancelled": count })),
                    );
                }
                cancelled
            }
            (None, None) => Ok(0),
        };
        if let Err(message) = &cancelled {
            logging::error("Failed to cancel jobs", fields(json!({ "error": message })));
        }
        answer(cancelled)
    }

    /// A pending job is cancelled now; a running one is its worker's to stop.
    async fn cancel_one(&self, id: &JobId) -> Result<u64, String> {
        let cancelled = match self.queue.get_job(id).await.map_err(|e| e.0)? {
            None => 0,
            Some(Job::Pending(_)) => u64::from(self.queue.cancel_job(id).await.map_err(|e| e.0)?),
            Some(Job::Running(_)) => {
                logging::info(
                    "Cancel of running job delegated to its worker",
                    fields(json!({ "jobId": id.as_str() })),
                );
                1
            }
            Some(_) => 0,
        };
        logging::info(
            "Cancel requested",
            fields(json!({ "jobId": id.as_str(), "cancelled": cancelled })),
        );
        Ok(cancelled)
    }

    async fn status(&self, payload: Value, correlation_id: Option<String>) -> Vec<Reply> {
        let reply = |channel: &'static str, payload: Map<String, Value>| {
            vec![Reply {
                channel,
                payload,
                correlation_id: correlation_id.clone(),
            }]
        };
        let request: JobStatusRequest = match serde_json::from_value(payload) {
            Ok(request) => request,
            Err(error) => {
                return reply(
                    <<JobStatusRequested as Request>::Failure as Channel>::NAME,
                    failure(
                        format!("a job:status-requested that is not a JobStatusRequest: {error}"),
                        None,
                    ),
                );
            }
        };
        match self.queue.get_job(&request.job_id).await {
            Ok(Some(job)) => reply(
                <<JobStatusRequested as Request>::Result as Channel>::NAME,
                object(&JobStatusResult {
                    response: status_of(job),
                }),
            ),
            Ok(None) => reply(
                <<JobStatusRequested as Request>::Failure as Channel>::NAME,
                failure("Job not found", None),
            ),
            Err(error) => reply(
                <<JobStatusRequested as Request>::Failure as Channel>::NAME,
                failure(error.0, None),
            ),
        }
    }
}

/// What the dispatcher reads of a completion, whichever verb's it is: the
/// job, the verb as the completion's own member names it, and the result as
/// a record stores one, which is not typed by verb.
fn concluded(command: JobCompleteCommand) -> (JobId, &'static str, JobStoredResult) {
    let stored = |result: Option<JobResult>| match result {
        Some(result) => result.into(),
        None => JobStoredResult::Empty(Default::default()),
    };
    match command {
        JobCompleteCommand::MarkJobCompleteCommand(done) => (
            done.job_id,
            done.job_type.as_str(),
            stored(done.result.map(|result| match result {
                MarkJobResult::DetectionResult(counts) => counts.into(),
                MarkJobResult::DeclinedResult(declined) => declined.into(),
            })),
        ),
        JobCompleteCommand::YieldJobCompleteCommand(done) => (
            done.job_id,
            done.job_type.as_str(),
            stored(done.result.map(|result| match result {
                YieldJobResult::GenerationResult(made) => made.into(),
                YieldJobResult::DeclinedResult(declined) => declined.into(),
            })),
        ),
    }
}

/// What a job's status says of it (JOBS.md § `job:status-requested`).
fn status_of(job: Job) -> JobStatusResponse {
    let (metadata, status, started_at, completed_at, error, progress, result) = match job {
        Job::Pending(j) => (
            j.metadata,
            JobStatusResponseStatus::Pending,
            None,
            None,
            None,
            None,
            None,
        ),
        Job::Running(j) => (
            j.metadata,
            JobStatusResponseStatus::Running,
            Some(j.started_at),
            None,
            None,
            Some(j.progress),
            None,
        ),
        Job::Complete(j) => (
            j.metadata,
            JobStatusResponseStatus::Complete,
            Some(j.started_at),
            Some(j.completed_at),
            None,
            None,
            Some(j.result),
        ),
        Job::Failed(j) => (
            j.metadata,
            JobStatusResponseStatus::Failed,
            None,
            Some(j.completed_at),
            Some(j.error),
            None,
            None,
        ),
        Job::Cancelled(j) => (
            j.metadata,
            JobStatusResponseStatus::Cancelled,
            None,
            Some(j.completed_at),
            None,
            None,
            None,
        ),
    };
    JobStatusResponse {
        job_id: metadata.id,
        r#type: metadata.r#type,
        status,
        user_id: metadata.user_id,
        created: metadata.created,
        started_at,
        completed_at,
        error,
        progress,
        result,
    }
}
