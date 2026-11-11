//! Job: a job's lifecycle as it is announced, its status, its cancellation,
//! and, for a worker, the claiming of jobs. Creating a job is `mark.delegate`
//! and `yield_.delegate`.

use crate::bus::Typed;
use crate::channels::{
    JobCancelRequested, JobComplete, JobFail, JobQueued, JobReportProgress, JobStatusRequested,
};
use crate::claims::{ClaimOptions, Claims};
use crate::client::Links;
use crate::errors::{BusRequestError, BusRequestErrorCode, SemiontError};
use crate::event_bus::BusFrames;
use crate::timing::{JOB_POLL, JOB_POLL_TIMEOUT};
use crate::types::JobId;
use crate::types::{
    JobCancelRequest, JobStatusRequest, JobStatusResponse, JobStatusResponseStatus,
};
use std::time::Duration;
use tokio::time::Instant;

pub struct JobNamespace {
    links: Links,
}

impl JobNamespace {
    pub(crate) fn new(links: Links) -> JobNamespace {
        JobNamespace { links }
    }

    /// Every `job:queued` from now on: each pending job, announced with its
    /// description less its input. Whether one is a job a claim would take is
    /// `job_filter::job_matches_filter`'s to say.
    pub fn queued(&self) -> Typed<JobQueued, BusFrames> {
        self.links.own.stream::<JobQueued>()
    }

    /// Every `job:report-progress` from now on, of every job.
    pub fn progress(&self) -> Typed<JobReportProgress, BusFrames> {
        self.links.own.stream::<JobReportProgress>()
    }

    /// Every `job:complete` from now on, of every job.
    pub fn complete(&self) -> Typed<JobComplete, BusFrames> {
        self.links.own.stream::<JobComplete>()
    }

    /// Every `job:fail` from now on, of every job.
    pub fn fail(&self) -> Typed<JobFail, BusFrames> {
        self.links.own.stream::<JobFail>()
    }

    pub async fn status(&self, job_id: &JobId) -> Result<JobStatusResponse, SemiontError> {
        let status = self
            .links
            .request::<JobStatusRequested>(&JobStatusRequest {
                job_id: job_id.clone(),
            })
            .await?;
        Ok(status.response)
    }

    /// Ask for a job's status at once, and then every `every`
    /// (`timing::JOB_POLL` when it is `None`), until it has ended, giving
    /// each answer to `on_status`: the status it ended with. One that has not
    /// ended `within` (`timing::JOB_POLL_TIMEOUT` when it is `None`) of the
    /// first ask, its asks and the waits between them included, fails as a
    /// timeout at that limit.
    pub async fn poll_until_complete(
        &self,
        job_id: &JobId,
        every: Option<Duration>,
        within: Option<Duration>,
        mut on_status: impl FnMut(&JobStatusResponse),
    ) -> Result<JobStatusResponse, SemiontError> {
        let every = every.unwrap_or(JOB_POLL);
        let within = within.unwrap_or(JOB_POLL_TIMEOUT);
        let deadline = Instant::now() + within;
        let timed_out = || -> SemiontError {
            BusRequestError::new(
                BusRequestErrorCode::Timeout,
                format!("Job polling timeout after {}ms", within.as_millis()),
            )
            .into()
        };
        loop {
            let Ok(asked) = tokio::time::timeout_at(deadline, self.status(job_id)).await else {
                return Err(timed_out());
            };
            let status = asked?;
            on_status(&status);
            match status.status {
                JobStatusResponseStatus::Complete
                | JobStatusResponseStatus::Failed
                | JobStatusResponseStatus::Cancelled => return Ok(status),
                JobStatusResponseStatus::Pending | JobStatusResponseStatus::Running => {}
            }
            tokio::time::sleep_until((Instant::now() + every).min(deadline)).await;
            if Instant::now() >= deadline {
                return Err(timed_out());
            }
        }
    }

    /// Cancel one job: whether the queue acted on it. A pending job is
    /// cancelled outright; a running one is left to its worker, so true
    /// means accepted, not stopped. False is a job the queue does not know,
    /// or one already over.
    pub async fn cancel(&self, job_id: &JobId) -> Result<bool, SemiontError> {
        let request = JobCancelRequest {
            job_id: job_id.clone(),
        };
        let answer = self.links.request::<JobCancelRequested>(&request).await?;
        Ok(answer.response.cancelled)
    }

    /// A worker's side: claim the jobs `options.accepts` describes, and hold
    /// one at a time. Claiming begins when the claims are first read, and each
    /// job they hand out says its own lifecycle, commits its own annotations
    /// and settles once (protocol/contract/WORKER-CONTRACT.md). The transport's
    /// stream must name `claims::JOB_CLAIM_CHANNELS`, and
    /// `claims::JOB_COMMIT_CHANNELS` for a worker that commits.
    pub fn claim(&self, options: ClaimOptions) -> Claims {
        Claims::new(self.links.transport.clone(), options)
    }
}
