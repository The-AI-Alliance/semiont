//! The job queue the handlers drive, as a contract any broker can keep.
//!
//! A queue holds one record per job (`semiont::types::Job`) and moves it
//! through the states docs/protocol/JOBS.md gives it. What a queue must
//! provide, whatever holds it:
//!
//! - **An atomic claim by type.** Of any number of simultaneous claims, one
//!   wins each pending job; the rest are declined, never errors.
//! - **Safe transitions.** Each transition reads the record, checks the state
//!   it needs and writes only if nothing wrote in between; one of two racing
//!   transitions wins and the other finds the job no longer in that state.
//! - **Redelivery of abandoned work.** A pending job the dispatcher was
//!   holding when it stopped reaches the next dispatcher, which announces it.
//! - **Announcements.** A pending job is announced (`job:queued`) when it is
//!   delivered to the dispatcher, and again at every tick while it waits.
//! - **The periodic work.** The tick re-announces and sweeps running jobs a
//!   worker abandoned; retention deletes concluded jobs past their window.
//!
//! What is private to a queue: how it stores and revisions a record, how it
//! delivers and leases a job, what it names things on its broker, and how it
//! schedules its clocks. Nothing here names a broker, and the handlers see
//! nothing else.

use semiont::types::{
    FailureClass, Job, JobCancelRequestJobType, JobId, JobPending, JobRunning, JobStoredProgress,
    JobStoredResult, UnitCursor,
};
use std::collections::BTreeMap;
use std::fmt;
use std::future::Future;

/// A queue operation that failed: the queue's own message, which a refusal carries.
#[derive(Debug)]
pub struct QueueError(pub String);

impl fmt::Display for QueueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for QueueError {}

/// What a claim got.
#[derive(Debug)]
pub enum Claim {
    /// A pending job of a requested type, now running for the claimant.
    Claimed(Box<JobRunning>),
    /// No pending job of the requested types.
    Declined,
}

/// What a failure did to a running job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailOutcome {
    /// Pending again, one retry counted.
    Retried,
    /// Failed for good.
    Failed,
}

/// How many jobs the queue holds, by status. The terminal counts are the
/// retention window, not totals.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    pub pending: u64,
    pub running: u64,
    pub complete: u64,
    pub failed: u64,
    pub cancelled: u64,
}

/// A checkpoint: units finished, and how far unfinished ones got.
#[derive(Debug, Clone, Default)]
pub struct Checkpoint {
    pub completed_units: Vec<String>,
    pub unit_cursors: Option<BTreeMap<String, UnitCursor>>,
}

pub trait JobQueue: Send + Sync + 'static {
    /// Store a new pending job and make it deliverable. Fails if the id exists.
    fn create_job(&self, job: JobPending) -> impl Future<Output = Result<(), QueueError>> + Send;

    /// The job's record, if the queue holds one.
    fn get_job(&self, id: &JobId) -> impl Future<Output = Result<Option<Job>, QueueError>> + Send;

    /// Move one pending job of the given types (any type, when none are
    /// given) to running, atomically.
    fn claim_next_job(
        &self,
        types: &[String],
    ) -> impl Future<Output = Result<Claim, QueueError>> + Send;

    /// A running job completes with its result; `false` when it was not running.
    fn complete_job(
        &self,
        id: &JobId,
        result: JobStoredResult,
    ) -> impl Future<Output = Result<bool, QueueError>> + Send;

    /// A running job's attempt failed: its checkpoint merged, then retried or
    /// failed by the retry rule (`crate::retry`); `None` when it was not running.
    fn fail_job(
        &self,
        id: &JobId,
        error: String,
        checkpoint: Checkpoint,
        failure_class: Option<FailureClass>,
    ) -> impl Future<Output = Result<Option<FailOutcome>, QueueError>> + Send;

    /// Merge a running job's checkpoint, refreshing its liveness; nothing when it is not running.
    fn checkpoint_units(
        &self,
        id: &JobId,
        checkpoint: Checkpoint,
    ) -> impl Future<Output = Result<(), QueueError>> + Send;

    /// Replace a running job's progress, unless a report was written for it
    /// within the progress window; a report written refreshes its liveness.
    fn record_progress(
        &self,
        id: &JobId,
        progress: JobStoredProgress,
    ) -> impl Future<Output = Result<(), QueueError>> + Send;

    /// Cancel every pending job of the category; how many were cancelled.
    fn cancel_pending_jobs(
        &self,
        category: JobCancelRequestJobType,
    ) -> impl Future<Output = Result<u64, QueueError>> + Send;

    /// Cancel a pending or running job; `false` when it was neither.
    fn cancel_job(&self, id: &JobId) -> impl Future<Output = Result<bool, QueueError>> + Send;

    /// How many jobs the queue holds, by status.
    fn stats(&self) -> impl Future<Output = Result<Stats, QueueError>> + Send;
}
