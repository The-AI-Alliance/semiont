//! Following a job from its creation to its end (docs/protocol/JOBS.md
//! § Following a job).
//!
//! A job's progress and its end reach the client that created it as frames
//! with no identity of their own: a stream that is down when one is
//! published does not carry it later. So a follower that has heard nothing of
//! its job for `job_silence` asks for the job's status, and asks again every
//! `job_status_poll` until the job says something or its status is an end.
//! A reader that fell behind missed an unknown set of frames, which is the
//! same loss, and it asks at once.
//!
//! The follower listens before it creates the job: a frame of the job can be
//! read from the stream beside the reply that names it. Frames that arrive
//! before the job's id is known are held, and the job's are then handled in
//! the order they came.
//!
//! A failure the queue will retry is reported and followed past: the job is
//! not over. A failure it will not retry ends the follower with `job.failed`.
//! A follower given a stall deadline that hears nothing for that long asks
//! for the cancellation and ends with `job.stalled`.

use crate::bus::StreamError;
use crate::channels::{
    JobCancelRequested, JobComplete, JobCreate, JobFail, JobReportProgress, JobStatusRequested,
};
use crate::client::Links;
use crate::errors::{BusRequestError, BusRequestErrorCode, JobError, JobErrorCode, SemiontError};
use crate::running::{Reporter, Running};
use crate::transport::BoxFuture;
use crate::types::{
    JobCancelRequest, JobCancelRequestJobType, JobCompleteCommand, JobCreateCommand,
    JobCreatedResult, JobFailCommand, JobProgress, JobReportProgressCommand, JobStatusRequest,
    JobStatusResponse, JobStatusResponseStatus, JobStoredResult,
};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::time::Duration;
use tokio::time::Instant;

/// What a followed job reports, and how it ends. As JSON it is
/// `{"kind": "progress", "data": …}`, the same event in every SDK.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "lowercase")]
pub enum JobEvent {
    /// The job's progress.
    Progress(JobProgress),
    /// An attempt failed and the queue will try again. The job is not over.
    Failed(JobFailCommand),
    /// The job completed. A follower's last value.
    Complete(JobCompleteCommand),
}

/// A job to create and follow.
pub(crate) struct Following {
    pub create: JobCreateCommand,
    /// The resource the job is about, for a completion learned from the
    /// job's status, which does not state it.
    pub resource_id: String,
    /// When the follower gives up on a job that says nothing.
    pub stall: Option<Stall>,
}

#[derive(Clone, Copy)]
pub(crate) struct Stall {
    /// How long the job may say nothing.
    pub within: Duration,
    /// The category of jobs a follower that gave up asks to be cancelled.
    pub cancels: JobCancelRequestJobType,
}

pub(crate) fn follow(links: Links, following: Following) -> Running<JobEvent> {
    Running::new(move |reporter| followed(links, following, reporter))
}

/// A frame of some job's lifecycle.
enum Heard {
    Progress(JobReportProgressCommand),
    Complete(JobCompleteCommand),
    Fail(JobFailCommand),
}

impl Heard {
    fn job_id(&self) -> &str {
        match self {
            Heard::Progress(frame) => &frame.job_id,
            Heard::Complete(frame) => &frame.job_id,
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

fn failed(job_id: &str, message: String) -> SemiontError {
    JobError {
        code: JobErrorCode::Failed,
        job_id: Some(job_id.to_owned()),
        message,
    }
    .into()
}

async fn followed(
    links: Links,
    following: Following,
    reporter: Reporter<JobEvent>,
) -> Result<JobEvent, SemiontError> {
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
    let mut job_id: Option<String> = None;
    let mut held: Vec<Heard> = Vec::new();
    let mut ask_at: Option<Instant> = None;
    let mut asking: Option<BoxFuture<'static, Result<JobStatusResponse, SemiontError>>> = None;
    let mut stall_at = stall.map(|stall| Instant::now() + stall.within);

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
                job_id = Some(created?.response.job_id);
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
                            return Ok(JobEvent::Complete(JobCompleteCommand {
                                _user_id: None,
                                resource_id,
                                job_id: status.job_id,
                                job_type: status.r#type,
                                attempt: None,
                                annotation_id: None,
                                // A job completed without a result is stored with an empty one.
                                result: match status.result {
                                    Some(JobStoredResult::JobResult(result)) => Some(result),
                                    Some(JobStoredResult::Empty(_)) | None => None,
                                },
                                durability: None,
                            }));
                        }
                        JobStatusResponseStatus::Failed => {
                            return Err(failed(
                                &status.job_id,
                                status.error.unwrap_or_else(|| "Job failed".to_owned()),
                            ));
                        }
                        JobStatusResponseStatus::Pending
                        | JobStatusResponseStatus::Running
                        | JobStatusResponseStatus::Cancelled => {}
                    }
                }
            }
            Step::Stalled => {
                let Some(stall) = stall else { continue };
                // Asked for on its own task: the follower ends here, and the
                // request must outlive it.
                let links = links.clone();
                tokio::spawn(async move {
                    let _ = links
                        .request::<JobCancelRequested>(&JobCancelRequest {
                            job_id: None,
                            job_type: Some(stall.cancels),
                        })
                        .await;
                });
                return Err(JobError {
                    code: JobErrorCode::Stalled,
                    job_id,
                    message: format!(
                        "The job stalled: nothing was heard of it within {}ms, and its cancellation was requested",
                        stall.within.as_millis()
                    ),
                }
                .into());
            }
        }

        let Some(following_id) = job_id.as_deref() else {
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
                    stall_at = stall.map(|stall| Instant::now() + stall.within);
                }
                Heard::Complete(frame) => return Ok(JobEvent::Complete(frame)),
                // The queue re-queues the job and another attempt continues
                // it. The dead attempt's status is not asked for: the next
                // attempt's first frame starts the silence again.
                Heard::Fail(frame) if frame.will_retry == Some(true) => {
                    ask_at = None;
                    reporter.report(JobEvent::Failed(frame));
                }
                // Absent reads as final: a follower that ends early is seen,
                // one that never ends is not.
                Heard::Fail(frame) => return Err(failed(&frame.job_id, frame.error)),
            }
        }
    }
}
