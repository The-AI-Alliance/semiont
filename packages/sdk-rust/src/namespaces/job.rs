//! Job: a job's lifecycle as it is announced, its status, and its
//! cancellation. Creating a job is `mark.assist` and `yield_.from_context`.

use crate::bus::Typed;
use crate::channels::{
    JobCancelRequested, JobComplete, JobFail, JobQueued, JobReportProgress, JobStatusRequested,
};
use crate::client::Links;
use crate::errors::{BusRequestError, BusRequestErrorCode, SemiontError};
use crate::event_bus::BusFrames;
use crate::transport::Envelope;
use crate::types::{
    JobCancelRequest, JobCancelRequestJobType, JobStatusRequest, JobStatusResponse,
    JobStatusResponseStatus,
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

    /// Every `job:queued` from now on.
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

    pub async fn status(&self, job_id: &str) -> Result<JobStatusResponse, SemiontError> {
        let status = self
            .links
            .request::<JobStatusRequested>(&JobStatusRequest {
                job_id: job_id.to_owned(),
            })
            .await?;
        Ok(status.response)
    }

    /// Ask for a job's status every `every` until it has ended, giving each
    /// answer to `on_status`: the status it ended with. One that has not
    /// ended `within` that long fails as a timeout.
    pub async fn poll_until_complete(
        &self,
        job_id: &str,
        every: Duration,
        within: Duration,
        mut on_status: impl FnMut(&JobStatusResponse),
    ) -> Result<JobStatusResponse, SemiontError> {
        let deadline = Instant::now() + within;
        loop {
            let status = self.status(job_id).await?;
            on_status(&status);
            match status.status {
                JobStatusResponseStatus::Complete
                | JobStatusResponseStatus::Failed
                | JobStatusResponseStatus::Cancelled => return Ok(status),
                JobStatusResponseStatus::Pending | JobStatusResponseStatus::Running => {}
            }
            if Instant::now() > deadline {
                return Err(BusRequestError::new(
                    BusRequestErrorCode::Timeout,
                    format!("Job polling timeout after {}ms", within.as_millis()),
                )
                .into());
            }
            tokio::time::sleep(every).await;
        }
    }

    /// Cancel every pending job of a category: how many were cancelled.
    /// Running jobs are their workers' to stop.
    pub async fn cancel_by_type(
        &self,
        job_type: JobCancelRequestJobType,
    ) -> Result<i64, SemiontError> {
        self.cancelled(JobCancelRequest {
            job_id: None,
            job_type: Some(job_type),
        })
        .await
    }

    /// Cancel one job: how many the queue acted on. A pending job is
    /// cancelled outright; a running one is left to its worker, so one means
    /// accepted, not stopped.
    pub async fn cancel(&self, job_id: &str) -> Result<i64, SemiontError> {
        self.cancelled(JobCancelRequest {
            job_id: Some(job_id.to_owned()),
            job_type: None,
        })
        .await
    }

    /// Signal: the cancellation of a category is wanted.
    pub fn cancel_request(&self, job_type: JobCancelRequestJobType) {
        self.links.signal::<JobCancelRequested>(
            &JobCancelRequest {
                job_id: None,
                job_type: Some(job_type),
            },
            Envelope::default(),
        );
    }

    async fn cancelled(&self, request: JobCancelRequest) -> Result<i64, SemiontError> {
        let answer = self.links.request::<JobCancelRequested>(&request).await?;
        Ok(answer.response.cancelled)
    }
}
