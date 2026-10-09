//! Following a job from its creation to its end (docs/protocol/JOBS.md
//! § Following a job).
//!
//! A job's progress and its end reach the client that created it as passing
//! frames: a stream that is down when one is published does not carry it
//! later. So a follower that has heard nothing of
//! its job for `job_silence` asks for the job's status, and asks again every
//! `job_status_poll` until the job says something or its status is an end.
//! A reader that fell behind missed an unknown set of frames, which is the
//! same loss, and it asks at once.
//!
//! The follower listens before it creates the job: a frame of the job can be
//! read from the stream beside the reply that names it. Frames that arrive
//! before the job's id is known are held, and the job's are then handled in
//! the order they came. The reply itself is the follower's first event: it
//! names the job, to `job.cancel` and to `job.status`.
//!
//! A failure the queue will retry is reported and followed past: the job is
//! not over. A failure it will not retry ends the follower with `job.failed`.
//! A follower given a stall deadline that hears nothing for that long asks
//! for the cancellation and ends with `job.stalled`.
//!
//! A job's completion is its verb's (`Completion`): a `mark` job's carries
//! what a `mark` job reports, a `yield` job's what a `yield` job reports. A
//! follower learns of one from a `job:complete` frame, or from the job's
//! status when the stream did not carry the frame, and reads either as its
//! own verb's. One that is another verb's is not the protocol's answer for
//! this job: the follower ends with a transport error, and the job is not
//! said to have failed.

use crate::bus::StreamError;
use crate::channels::{
    JobCancelRequested, JobComplete, JobCreate, JobFail, JobReportProgress, JobStatusRequested,
};
use crate::client::Links;
use crate::errors::{
    BusRequestError, BusRequestErrorCode, JobError, JobErrorCode, SemiontError, TransportError,
    TransportErrorCode,
};
use crate::running::{Reporter, Running};
use crate::transport::BoxFuture;
use crate::types::{
    JobCancelRequest, JobCompleteCommand, JobCreateCommand, JobCreatedResult,
    JobCreatedResultResponse, JobFailCommand, JobId, JobProgress, JobReportProgressCommand,
    JobStatusRequest, JobStatusResponse, JobStatusResponseStatus, JobStoredResult,
    MarkJobCompleteCommand, ResourceId, YieldJobCompleteCommand,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::time::Duration;
use tokio::time::Instant;

/// What a followed job reports, and how it ends. As JSON it is
/// `{"kind": "progress", "data": …}`, the same event in every SDK. `C` is the
/// completion of the job's verb.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "lowercase")]
pub enum JobEvent<C> {
    /// The queue's answer to the job's creation, naming the job. A
    /// follower's first event.
    Created(JobCreatedResultResponse),
    /// The job's progress.
    Progress(JobProgress),
    /// An attempt failed and the queue will try again. The job is not over.
    Failed(JobFailCommand),
    /// The job completed. A follower's last event.
    Complete(C),
}

impl<C> From<C> for JobEvent<C> {
    fn from(completion: C) -> JobEvent<C> {
        JobEvent::Complete(completion)
    }
}

/// A job another party does. Read as a stream it gives the job's events, the
/// completion last; awaited it gives the completion. `C` is the completion of
/// the job's verb: `MarkJobCompleteCommand` from `mark.delegate`,
/// `YieldJobCompleteCommand` from `yield_.delegate`.
pub type Delegation<C> = Running<JobEvent<C>, C>;

/// A verb's completion, read from the two places a follower learns of one.
/// Each reading is through the generated type, so what is not this verb's
/// does not read as it.
pub(crate) trait Completion: Sized + Send + 'static {
    /// A `job:complete` frame as this verb's; none when it is another's.
    fn of_frame(frame: JobCompleteCommand) -> Option<Self>;

    /// A status that says its job completed, as this verb's completion of the
    /// job, which is about `resource_id`; none when the status's type, or its
    /// result, is not this verb's.
    fn of_status(status: JobStatusResponse, resource_id: ResourceId) -> Option<Self>;
}

/// A stored result read as `R`, a verb's own: nothing for a job that
/// completed with none, which is stored as the empty object. `None` when the
/// result is not an `R`.
fn stored_as<R: DeserializeOwned>(stored: Option<JobStoredResult>) -> Option<Option<R>> {
    match stored {
        Some(JobStoredResult::JobResult(result)) => {
            let said = serde_json::to_value(result).ok()?;
            serde_json::from_value(said).ok().map(Some)
        }
        Some(JobStoredResult::Empty(_)) | None => Some(None),
    }
}

/// A member of `JobCompleteCommand` is its verb's completion. A status states
/// a job's type under another name than a completion does, and does not
/// state the resource: the completion made from one states the type its own
/// member does, and only when that is the status's.
macro_rules! completion {
    ($member:ident) => {
        impl Completion for $member {
            fn of_frame(frame: JobCompleteCommand) -> Option<Self> {
                match frame {
                    JobCompleteCommand::$member(done) => Some(done),
                    _ => None,
                }
            }

            fn of_status(status: JobStatusResponse, resource_id: ResourceId) -> Option<Self> {
                let done = $member::new(resource_id, status.job_id);
                if done.job_type.as_str() != status.r#type.as_str() {
                    return None;
                }
                Some($member {
                    result: stored_as(status.result)?,
                    ..done
                })
            }
        }
    };
}

completion!(MarkJobCompleteCommand);
completion!(YieldJobCompleteCommand);

/// A job to create and follow.
pub(crate) struct Following {
    pub create: JobCreateCommand,
    /// The resource the job is about, for a completion learned from the
    /// job's status, which does not state it.
    pub resource_id: ResourceId,
    /// How long the job may say nothing before its follower gives up on it.
    pub stall: Option<Duration>,
}

pub(crate) fn follow<C: Completion>(links: Links, following: Following) -> Delegation<C> {
    Running::new(move |reporter| followed(links, following, reporter))
}

/// The job a completion is of, whichever verb's it is.
fn completed_job(frame: &JobCompleteCommand) -> &JobId {
    match frame {
        JobCompleteCommand::MarkJobCompleteCommand(done) => &done.job_id,
        JobCompleteCommand::YieldJobCompleteCommand(done) => &done.job_id,
    }
}

/// A frame of some job's lifecycle.
enum Heard {
    Progress(JobReportProgressCommand),
    Complete(JobCompleteCommand),
    Fail(JobFailCommand),
}

impl Heard {
    fn job_id(&self) -> &JobId {
        match self {
            Heard::Progress(frame) => &frame.job_id,
            Heard::Complete(frame) => completed_job(frame),
            Heard::Fail(frame) => &frame.job_id,
        }
    }
}

enum Step {
    Created(Result<JobCreatedResult, SemiontError>),
    Heard(Heard),
    /// The reader fell behind: some frames were missed.
    Missed,
    /// A frame that is not its channel's: nobody's to act on.
    Unreadable,
    /// The client's bus ended.
    Ended,
    AskDue,
    Status(Result<JobStatusResponse, SemiontError>),
    Stalled,
}

/// `future`'s output when there is one to wait for; otherwise never.
async fn when<F: Future + Unpin>(future: &mut Option<F>) -> F::Output {
    match future {
        Some(future) => future.await,
        None => std::future::pending().await,
    }
}

async fn at(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

fn heard<T>(item: Option<Result<T, StreamError>>, of: impl FnOnce(T) -> Heard) -> Step {
    match item {
        Some(Ok(frame)) => Step::Heard(of(frame)),
        Some(Err(StreamError::Lagged(_))) => Step::Missed,
        Some(Err(StreamError::Undecodable(_))) => Step::Unreadable,
        None => Step::Ended,
    }
}

fn failed(job_id: &JobId, message: String) -> SemiontError {
    JobError {
        code: JobErrorCode::Failed,
        job_id: Some(job_id.clone()),
        message,
    }
    .into()
}

/// The knowledge base said the job completed, and what it said is not a
/// completion of the verb that was delegated. Nothing says the job failed.
fn not_the_verbs(job_id: &JobId, said_in: &str) -> SemiontError {
    TransportError::without_response(
        format!("{said_in} of job {job_id} is not a completion of the verb that was delegated"),
        TransportErrorCode::Error,
    )
    .into()
}

async fn followed<C: Completion>(
    links: Links,
    following: Following,
    reporter: Reporter<JobEvent<C>>,
) -> Result<C, SemiontError> {
    let Following {
        create,
        resource_id,
        stall,
    } = following;
    let mut progress = links.own.stream::<JobReportProgress>();
    let mut complete = links.own.stream::<JobComplete>();
    let mut fail = links.own.stream::<JobFail>();

    let mut creating: Option<BoxFuture<'_, Result<JobCreatedResult, SemiontError>>> =
        Some(Box::pin(links.request::<JobCreate>(&create)));
    let mut job_id: Option<JobId> = None;
    let mut held: Vec<Heard> = Vec::new();
    let mut ask_at: Option<Instant> = None;
    let mut asking: Option<BoxFuture<'static, Result<JobStatusResponse, SemiontError>>> = None;
    let mut stall_at = stall.map(|within| Instant::now() + within);

    loop {
        // Frames come first, so one of this job's that is already here is
        // heard before the silence it ends is acted on. Checked here as well,
        // so other jobs' frames, however many, cannot put the deadline off.
        let stalled = stall_at.is_some_and(|deadline| Instant::now() >= deadline);
        let step = tokio::select! {
            biased;
            () = std::future::ready(()), if stalled => Step::Stalled,
            created = when(&mut creating) => Step::Created(created),
            item = progress.next() => heard(item.map(|i| i.map(|d| d.payload)), Heard::Progress),
            item = fail.next() => heard(item.map(|i| i.map(|d| d.payload)), Heard::Fail),
            item = complete.next() => heard(item.map(|i| i.map(|d| d.payload)), Heard::Complete),
            status = when(&mut asking) => Step::Status(status),
            () = at(ask_at) => Step::AskDue,
            () = at(stall_at) => Step::Stalled,
        };

        let mut frames = Vec::new();
        match step {
            Step::Created(created) => {
                creating = None;
                let created = created?.response;
                job_id = Some(created.job_id.clone());
                // Ahead of the frames held for it: the job's id is the first
                // thing its follower gives.
                reporter.report(JobEvent::Created(created));
                ask_at = Some(Instant::now() + links.timing.job_silence);
                frames = std::mem::take(&mut held);
            }
            Step::Heard(frame) if job_id.is_none() => held.push(frame),
            Step::Heard(frame) => frames.push(frame),
            Step::Unreadable => {}
            Step::Ended => {
                return Err(BusRequestError::new(
                    BusRequestErrorCode::Closed,
                    "The client closed while it was following a job",
                )
                .into());
            }
            // What was missed is asked for now rather than after a silence.
            Step::Missed => ask_at = job_id.as_ref().map(|_| Instant::now()),
            Step::AskDue => {
                ask_at = Some(Instant::now() + links.timing.job_status_poll);
                if let (None, Some(job_id)) = (&asking, &job_id) {
                    let links = links.clone();
                    let request = JobStatusRequest {
                        job_id: job_id.clone(),
                    };
                    asking = Some(Box::pin(async move {
                        Ok(links
                            .request::<JobStatusRequested>(&request)
                            .await?
                            .response)
                    }));
                }
            }
            Step::Status(status) => {
                asking = None;
                // A status that could not be had is asked for again at the next poll.
                if let Ok(status) = status {
                    match status.status {
                        JobStatusResponseStatus::Complete => {
                            let job_id = status.job_id.clone();
                            return C::of_status(status, resource_id)
                                .ok_or_else(|| not_the_verbs(&job_id, "The status"));
                        }
                        JobStatusResponseStatus::Failed => {
                            return Err(failed(
                                &status.job_id,
                                status.error.unwrap_or_else(|| "Job failed".to_owned()),
                            ));
                        }
                        // Nothing announces a cancellation: this is where
                        // its follower learns of one.
                        JobStatusResponseStatus::Cancelled => {
                            return Err(JobError {
                                code: JobErrorCode::Cancelled,
                                job_id: Some(status.job_id),
                                message: "The job was cancelled".to_owned(),
                            }
                            .into());
                        }
                        JobStatusResponseStatus::Pending | JobStatusResponseStatus::Running => {}
                    }
                }
            }
            Step::Stalled => {
                let Some(within) = stall else { continue };
                // A job whose creation was never answered has no id, and
                // there is nothing to cancel. Asked for on its own task: the
                // follower ends here, and the request must outlive it.
                if let Some(stalled) = job_id.clone() {
                    let links = links.clone();
                    tokio::spawn(async move {
                        let _ = links
                            .request::<JobCancelRequested>(&JobCancelRequest { job_id: stalled })
                            .await;
                    });
                }
                return Err(JobError {
                    code: JobErrorCode::Stalled,
                    job_id,
                    message: format!(
                        "The job stalled: nothing was heard of it within {}ms",
                        within.as_millis()
                    ),
                }
                .into());
            }
        }

        let Some(following_id) = job_id.as_ref() else {
            continue;
        };
        for frame in frames {
            if frame.job_id() != following_id {
                continue;
            }
            match frame {
                Heard::Progress(frame) => {
                    if let Some(progress) = frame.progress {
                        reporter.report(JobEvent::Progress(progress));
                    }
                    ask_at = Some(Instant::now() + links.timing.job_silence);
                    stall_at = stall.map(|within| Instant::now() + within);
                }
                Heard::Complete(frame) => {
                    return C::of_frame(frame)
                        .ok_or_else(|| not_the_verbs(following_id, "A job:complete"));
                }
                // The queue re-queues the job and another attempt continues
                // it. The dead attempt's status is not asked for: the next
                // attempt's first frame starts the silence again. The
                // setback was heard, so the stall deadline starts again:
                // one left running would cancel the attempt that is coming.
                Heard::Fail(frame) if frame.will_retry == Some(true) => {
                    ask_at = None;
                    stall_at = stall.map(|within| Instant::now() + within);
                    reporter.report(JobEvent::Failed(frame));
                }
                // Absent reads as final: a follower that ends early is seen,
                // one that never ends is not.
                Heard::Fail(frame) => return Err(failed(&frame.job_id, frame.error)),
            }
        }
    }
}
