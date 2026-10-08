//! A worker's side of the job queue: `job.claim`.
//!
//! A worker is any party that takes jobs and says how each one went. What it
//! promises the dispatcher, and everyone who follows a job, is
//! docs/protocol/WORKER-CONTRACT.md; this module is that contract for Rust,
//! and the worker conformance suite (tests/conformance/worker) holds it on
//! the wire.
//!
//! THE MODEL. A worker asks the queue at every moment it becomes idle, and
//! never otherwise. `job:claim` carries the jobs it takes; the dispatcher
//! answers with the next pending job that matches one of them, or declines.
//! Queue state is the truth, and no message carries correctness. The idle
//! moments:
//!
//!   - its claims are first read, once the stream is open;
//!   - it settles the job it holds, immediately, with no timer;
//!   - a matching `job:queued` arrives while it holds nothing;
//!   - the stream opens again: every edge into `Open` after the first.
//!
//! `job:queued` is a WAKE-UP with no memory. While the worker holds nothing
//! it causes a claim; while a claim is in flight it sets a bit that earns
//! exactly one more claim, so a wake-up cannot be lost in that window; while
//! a job is held it is ignored, because the settle claims. The check of a
//! wake-up is a PRE-FILTER: an announcement carries the job description less
//! its input, so the worker asks its own claim's question of it,
//! `job_matches_filter`, the comparison the dispatcher makes, and does not
//! spend a round trip to be declined.
//!
//! A HELD JOB owns its lifecycle. It says its own start, progress and
//! checkpoints, and it settles once: `complete`, `fail` and `cancel` each
//! take the job by value, say the outcome and release it in one call, so
//! settling twice does not compile. One dropped without being settled is
//! failed.
//!
//! A HELD JOB COMMITS FOR ITSELF. `commit` sends a batch of annotations to
//! the record, citing the job, and returns once the batch is established: the
//! record acknowledged it, or, when no acknowledgement came, answered that
//! the batch's last annotation is on the resource. The job remembers the
//! weakest of what its commits observed and states it when it settles, so a
//! worker says neither which job a batch is for nor how its commits went.
//!
//! The claiming runs on a task of its own, begun when the claims are first
//! read. So a cancellation reaches the held job, a stall is looked for, and
//! every announcement is stamped, while whoever holds the job is busy with
//! the work and reads nothing.

use crate::bus::{Bus, Operation, payload_of};
use crate::channels::{
    BrowseAnnotationRequested, Channel, JobCancel, JobCancelRequested, JobCheckpoint, JobClaim,
    JobComplete, JobFail, JobQueued, JobReportProgress, JobStart, MarkCommit, Request,
};
use crate::errors::{BusRequestErrorCode, SemiontError, TransportError, TransportErrorCode};
use crate::job_filter::job_matches_filter;
use crate::locked;
use crate::timing::{HELD_JOB_STALL, HELD_JOB_STALL_CHECK, JOB_CLAIM_TIMEOUT, MARK_COMMIT_TIMEOUT};
use crate::transport::{ConnectionState, Envelope};
use crate::types::{
    Annotation, AnnotationId, BrowseAnnotationRequest, DurabilityEvidence, FailureClass,
    JobCancelCommand, JobCheckpointCommand, JobClaimCommand, JobCompleteCommand, JobFailCommand,
    JobFilter, JobId, JobMetadata, JobParams, JobProgress, JobReportProgressCommand, JobRunning,
    JobStartCommand, JobType, MarkCommitCommand, MarkJobCompleteCommand, MarkJobResult, ResourceId,
    UnitCursor, YieldJobCompleteCommand, YieldJobResult,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::future::Future;
use std::marker::PhantomData;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::sync::{Notify, mpsc, watch};
use tokio::time::{Instant, MissedTickBehavior};

/// What a worker's stream names for its claims: the replies of `job:claim`,
/// and the two broadcasts a worker reads. `job:queued` and
/// `job:cancel-requested` reach only a stream that names them, so a transport
/// made for a worker is given these beside the reply channels of whatever
/// else the worker awaits.
pub const JOB_CLAIM_CHANNELS: [&str; 4] = [
    <<JobClaim as Request>::Result as Channel>::NAME,
    <<JobClaim as Request>::Failure as Channel>::NAME,
    JobQueued::NAME,
    JobCancelRequested::NAME,
];

/// What a worker's stream names for its commits: the replies of `mark:commit`
/// and of the question it asks when one goes unacknowledged.
///
/// The question is the read of ONE annotation, and not of a resource's list
/// of them. Reply channels reach every stream that names them, and the list's
/// replies are the frames of many megabytes a worker's stream exists to keep
/// out; one annotation's frame is small.
pub const JOB_COMMIT_CHANNELS: [&str; 4] = [
    <<MarkCommit as Request>::Result as Channel>::NAME,
    <<MarkCommit as Request>::Failure as Channel>::NAME,
    <<BrowseAnnotationRequested as Request>::Result as Channel>::NAME,
    <<BrowseAnnotationRequested as Request>::Failure as Channel>::NAME,
];

/// How weak an observation of a commit is, as evidence that the batch is on
/// the record. The two a commit is not established by are equally weak: one
/// says the record answered that the annotation is not there, the other that
/// nobody answered, and neither says more than the other.
const fn weakness(evidence: DurabilityEvidence) -> u8 {
    match evidence {
        DurabilityEvidence::Acknowledged => 0,
        DurabilityEvidence::ProbeConfirmed => 1,
        DurabilityEvidence::ProbeRefused | DurabilityEvidence::ProbeUnreachable => 2,
    }
}

/// Whether a failed attempt is retried: exactly when the failure is not known
/// to be deterministic and the job has retries left, on the record before the
/// failure is applied.
///
/// Two places need the answer and they must never disagree: the dispatcher's
/// queue acts on it, and a worker reports it on `job:fail` as `willRetry`, so
/// a follower of the job knows whether the failure it just saw is the end.
/// This is the one implementation in Rust, which the Dispatcher uses too, and
/// specs/src/jobs/retry-cases.json is the table every language answers alike.
pub fn will_retry_after(metadata: &JobMetadata, failure_class: Option<FailureClass>) -> bool {
    failure_class != Some(FailureClass::Deterministic)
        && metadata.retry_count < metadata.max_retries
}

/// The waits a worker keeps, each the value of specs/src/client/timing.json
/// unless a caller that must not wait it out states another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimTiming {
    /// How long a claim waits for its answer.
    pub job_claim: Duration,
    /// How long a held job may show no activity before it is stalled.
    pub held_job_stall: Duration,
    /// How often a held job is looked at for a stall.
    pub held_job_stall_check: Duration,
    /// How long a commit waits for the record to acknowledge it, and then,
    /// when no acknowledgement came, for the answer to its question.
    pub mark_commit: Duration,
}

impl Default for ClaimTiming {
    fn default() -> ClaimTiming {
        ClaimTiming {
            job_claim: JOB_CLAIM_TIMEOUT,
            held_job_stall: HELD_JOB_STALL,
            held_job_stall_check: HELD_JOB_STALL_CHECK,
            mark_commit: MARK_COMMIT_TIMEOUT,
        }
    }
}

/// What a worker claims with.
#[derive(Debug, Clone)]
pub struct ClaimOptions {
    /// The jobs this worker takes: the claim's `accepts`, and what a
    /// `job:queued` is checked against. At least one.
    pub accepts: Vec<JobFilter>,
    pub timing: ClaimTiming,
}

impl ClaimOptions {
    /// Claim the jobs `accepts` describes, waiting as the table says.
    pub fn new(accepts: Vec<JobFilter>) -> ClaimOptions {
        ClaimOptions {
            accepts,
            timing: ClaimTiming::default(),
        }
    }
}

/// A claim that was refused for a reason other than "nothing pending".
///
/// `code` is the code the reply was given, or `None` when the refusal was
/// the worker's own: a reply that names no job, or a claim that could not be
/// sent. `NonePending` never appears: an empty queue is not a fault.
/// `Unauthorized` means this credential cannot claim, and will not be able to
/// later.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimRefusal {
    pub code: Option<BusRequestErrorCode>,
    pub message: String,
}

/// The job a worker holds, as its vitals name it.
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveJob {
    pub job_id: JobId,
    pub job_type: JobType,
    pub since: SystemTime,
}

/// What a worker can say of itself at any moment (WORKER-CONTRACT V1).
///
/// `last_queued_event_at` is any `job:queued` received, matching or not. On
/// an idle stack with an empty queue it stands still by design, so a still
/// stamp alone is not a fault of the stream. `last_activity_at` (a claim, a
/// progress report, a checkpoint, a settle) is the liveness of the work: a
/// job stuck partway stops advancing it, and that is what the stall rule
/// reads.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkerVitals {
    pub last_queued_event_at: Option<SystemTime>,
    pub last_claim_at: Option<SystemTime>,
    /// The last settle, whatever its outcome: a worker that fails and moves
    /// on is alive.
    pub last_finished_at: Option<SystemTime>,
    pub last_activity_at: Option<SystemTime>,
    pub active_job: Option<ActiveJob>,
    pub jobs_completed: u64,
}

/// A held job that showed no activity for `threshold` (WORKER-CONTRACT V2).
/// What its host does then is the host's.
#[derive(Debug, Clone, PartialEq)]
pub struct HeldJobStall {
    pub job_id: JobId,
    pub job_type: JobType,
    pub held_since: SystemTime,
    pub last_activity_at: SystemTime,
    pub silent_for: Duration,
    pub threshold: Duration,
}

/// What a failure carries beside its error. What the job's commits observed
/// is the held job's own to state.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct JobFailure {
    /// The failure's class, when the worker knows it.
    pub failure_class: Option<FailureClass>,
    /// The units finished before the failure.
    pub completed_units: Option<Vec<String>>,
    /// How far each unit begun and not finished got.
    pub unit_cursors: Option<BTreeMap<String, UnitCursor>>,
}

/// The error of a job failed because its worker stopped, and not because the
/// work failed.
const STOPPED_WHILE_HELD: &str = "The worker stopped while it held the job";
/// The error of a job whose handle was dropped before it was settled.
const DROPPED_UNSETTLED: &str = "The worker let go of the job without settling it";

/// A failure this side made: nothing was sent, or what was sent got no
/// further.
fn here(message: String) -> SemiontError {
    TransportError::without_response(message, TransportErrorCode::Error).into()
}

// ── What the loop and a held job share ──────────────────────────────────

/// A held job as its loop knows it: what its messages name it by, its
/// budget, and whether it has been settled.
struct Holding {
    resource_id: ResourceId,
    job_id: JobId,
    job_type: JobType,
    /// Which attempt this is, 1-based.
    attempt: i64,
    annotation_id: Option<AnnotationId>,
    budget: JobMetadata,
    /// Settled once, by whoever is first: the handle, the worker's stop, or
    /// the handle's drop.
    settled: AtomicBool,
    cancelled: watch::Sender<bool>,
    /// The weakest of what this job's commits observed, across every batch
    /// and every resource it committed on: the strongest thing still true of
    /// the job as a whole. None until a batch is committed, and never a
    /// default: a job that commits nothing states nothing.
    durability: Mutex<Option<DurabilityEvidence>>,
}

impl Holding {
    /// Remember `evidence` if it is weaker than what is remembered. Of two
    /// equally weak, the first seen is kept.
    fn observe(&self, evidence: DurabilityEvidence) {
        let mut remembered = locked(&self.durability);
        if remembered.is_none_or(|kept| weakness(evidence) > weakness(kept)) {
            *remembered = Some(evidence);
        }
    }

    /// What this job's commits observed, as its completion states it.
    fn observed(&self) -> Option<DurabilityEvidence> {
        *locked(&self.durability)
    }

    fn fail(&self, error: &str, failure: JobFailure) -> JobFailCommand {
        let will_retry = will_retry_after(&self.budget, failure.failure_class);
        JobFailCommand {
            attempt: Some(self.attempt),
            annotation_id: self.annotation_id.clone(),
            completed_units: failure.completed_units,
            unit_cursors: failure.unit_cursors,
            failure_class: failure.failure_class,
            will_retry: Some(will_retry),
            // Stated only when a commit was not established: what is weaker
            // than any observation that establishes one. Otherwise the
            // failure says nothing of the job's commits.
            durability: self.observed().filter(|observed| {
                weakness(*observed) > weakness(DurabilityEvidence::ProbeConfirmed)
            }),
            ..JobFailCommand::new(
                self.resource_id.clone(),
                self.job_id.clone(),
                self.job_type,
                error,
            )
        }
    }
}

#[derive(Default)]
struct State {
    held: Option<Arc<Holding>>,
    /// Whether a stall has been reported for the job held: one is reported once.
    stall_reported: bool,
    last_queued_event_at: Option<SystemTime>,
    last_claim_at: Option<SystemTime>,
    last_finished_at: Option<SystemTime>,
    /// When the work was last active, by the clock a silence is measured on
    /// and by the one it is told in.
    last_activity: Option<(Instant, SystemTime)>,
    held_since: Option<SystemTime>,
    jobs_completed: u64,
}

struct Inner {
    wire: Bus,
    accepts: Vec<JobFilter>,
    timing: ClaimTiming,
    state: Mutex<State>,
    /// An idle moment the loop cannot see for itself: a settle.
    settled: Notify,
    stall: watch::Sender<Option<HeldJobStall>>,
}

impl Inner {
    fn holding(&self) -> bool {
        locked(&self.state).held.is_some()
    }

    /// The work showed it is alive.
    fn active(&self) {
        locked(&self.state).last_activity = Some((Instant::now(), SystemTime::now()));
    }

    /// One of a commit's requests, waited on for `mark_commit`. It fails as a
    /// bus request fails. What answers it is not read: that an answer came
    /// on its result channel is all a commit asks, so the answer is not held
    /// to its type here.
    async fn ask<R: Request>(&self, payload: &R::Payload) -> Result<(), SemiontError> {
        self.wire
            .request_of(
                &Operation::of::<R>(),
                payload_of(payload)?,
                self.timing.mark_commit,
            )
            .await?;
        Ok(())
    }

    /// Is the annotation on the resource? Asked of the LAST annotation of a
    /// batch nobody acknowledged, and that is enough: the record appends a
    /// batch in order and stops at the first annotation it cannot append
    /// (WORKER-CONTRACT A5), so the last being there says every one before
    /// it is. One question, where asking of each would be a round trip for
    /// each annotation.
    ///
    /// Every answer but the annotation fails the commit, and the asymmetry is
    /// deliberate. The record appends only the annotations it does not hold,
    /// so a job retried over a batch that had landed costs one more run of
    /// the batch's unit; a wrong "it is there" loses the batch silently,
    /// which is what the acknowledgement exists to prevent. A question nobody
    /// answered is neither yes nor no. It is said as its own observation, and
    /// it does not establish the commit.
    async fn ask_whether_recorded(
        &self,
        resource_id: &ResourceId,
        annotation_id: AnnotationId,
    ) -> DurabilityEvidence {
        let question = BrowseAnnotationRequest {
            resource_id: resource_id.clone(),
            annotation_id,
        };
        match self.ask::<BrowseAnnotationRequested>(&question).await {
            Ok(()) => DurabilityEvidence::ProbeConfirmed,
            // A failure reply (`Rejected`) means the question was answered
            // and the answer was not the annotation. That is not "the
            // annotation is absent": a read that failed for its own reasons
            // answers on the same channel. So the job says what was observed,
            // and its reader judges.
            Err(SemiontError::Bus(answered)) if answered.code == BusRequestErrorCode::Rejected => {
                DurabilityEvidence::ProbeRefused
            }
            // Anything else (a timeout, a closed bus) means nobody answered.
            Err(_) => DurabilityEvidence::ProbeUnreachable,
        }
    }

    /// `holding` is the job this worker holds, from now.
    fn hold(&self, holding: &Arc<Holding>) {
        let now = SystemTime::now();
        let mut state = locked(&self.state);
        state.held = Some(holding.clone());
        state.stall_reported = false;
        state.last_claim_at = Some(now);
        state.last_activity = Some((Instant::now(), now));
        state.held_since = Some(now);
    }

    /// `holding` is settled, and no longer held.
    fn released(&self, holding: &Arc<Holding>, completed: bool) {
        {
            let mut state = locked(&self.state);
            if !state
                .held
                .as_ref()
                .is_some_and(|held| Arc::ptr_eq(held, holding))
            {
                return;
            }
            let now = SystemTime::now();
            state.held = None;
            state.held_since = None;
            state.last_finished_at = Some(now);
            state.last_activity = Some((Instant::now(), now));
            if completed {
                state.jobs_completed += 1;
            }
        }
        self.settled.notify_one();
    }

    /// Fail `holding` for a reason that is not the work's, unless it is
    /// settled already. The failure states no class, so the record's retry
    /// budget decides what becomes of the job.
    async fn fail_held(&self, holding: &Arc<Holding>, error: &str) {
        if holding.settled.swap(true, Ordering::SeqCst) {
            return;
        }
        let failed = holding.fail(error, JobFailure::default());
        let _ = self
            .wire
            .emit::<JobFail>(&failed, Envelope::default())
            .await;
        self.released(holding, false);
    }

    /// A cancellation is the held job's only when it names it, and one that
    /// arrives after the settle signals nothing.
    fn signal_cancellation(&self, job_id: &str) {
        let held = locked(&self.state).held.clone();
        if let Some(holding) = held
            && holding.job_id.as_str() == job_id
            && !holding.settled.load(Ordering::SeqCst)
        {
            holding.cancelled.send_replace(true);
        }
    }

    fn look_for_stall(&self) {
        let stall = {
            let mut state = locked(&self.state);
            let (Some(holding), Some((active, told)), Some(since)) =
                (state.held.clone(), state.last_activity, state.held_since)
            else {
                return;
            };
            let silent_for = active.elapsed();
            if state.stall_reported || silent_for <= self.timing.held_job_stall {
                return;
            }
            state.stall_reported = true;
            HeldJobStall {
                job_id: holding.job_id.clone(),
                job_type: holding.job_type,
                held_since: since,
                last_activity_at: told,
                silent_for,
                threshold: self.timing.held_job_stall,
            }
        };
        self.stall.send_replace(Some(stall));
    }

    fn vitals(&self) -> WorkerVitals {
        let state = locked(&self.state);
        WorkerVitals {
            last_queued_event_at: state.last_queued_event_at,
            last_claim_at: state.last_claim_at,
            last_finished_at: state.last_finished_at,
            last_activity_at: state.last_activity.map(|(_, told)| told),
            active_job: match (&state.held, state.held_since) {
                (Some(holding), Some(since)) => Some(ActiveJob {
                    job_id: holding.job_id.clone(),
                    job_type: holding.job_type,
                    since,
                }),
                _ => None,
            },
            jobs_completed: state.jobs_completed,
        }
    }
}

// ── The held job ────────────────────────────────────────────────────────

/// What a held job is made of, whatever its verb. Dropped without having
/// been settled, it fails its job: the queue retries it at once if its budget
/// allows, where a job nobody answered for would stay `running` until the
/// dispatcher's sweep.
struct Core {
    inner: Arc<Inner>,
    holding: Arc<Holding>,
    params: JobParams,
    completed_units: Vec<String>,
    unit_cursors: BTreeMap<String, UnitCursor>,
    /// Whether the job has said anything: `job:start` is its first message.
    begun: AtomicBool,
}

impl Core {
    fn unsettled(&self, saying: &str) -> Result<(), SemiontError> {
        if self.holding.settled.load(Ordering::SeqCst) {
            return Err(here(format!(
                "Job {} is already settled: it cannot say {saying}",
                self.holding.job_id
            )));
        }
        Ok(())
    }

    /// Say the outcome and release the job, together. The job is released
    /// whether or not the gateway took the message, because a worker that
    /// could not say its outcome must still go on claiming: the dispatcher's
    /// sweep concludes a job whose outcome never arrived.
    async fn settle<C: Channel>(
        self,
        payload: C::Payload,
        completed: bool,
    ) -> Result<(), SemiontError> {
        if self.holding.settled.swap(true, Ordering::SeqCst) {
            // Its worker stopped, and failed it, while the work went on.
            return Err(here(format!(
                "Job {} is already settled: it cannot say {}",
                self.holding.job_id,
                C::NAME
            )));
        }
        let sent = self
            .inner
            .wire
            .emit::<C>(&payload, Envelope::default())
            .await;
        self.inner.released(&self.holding, completed);
        sent.map(|_| ()).map_err(SemiontError::from)
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        if self.holding.settled.load(Ordering::SeqCst) {
            return;
        }
        let (inner, holding) = (self.inner.clone(), self.holding.clone());
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    inner.fail_held(&holding, DROPPED_UNSETTLED).await;
                });
            }
            // Nothing is left to say it with. The job is released, and the
            // dispatcher's sweep concludes it.
            Err(_) => {
                if !holding.settled.swap(true, Ordering::SeqCst) {
                    inner.released(&holding, false);
                }
            }
        }
    }
}

/// A `mark` job's verb, as a held job is typed by it.
pub struct Mark;
/// A `yield` job's verb, as a held job is typed by it.
pub struct Yield;

/// A job this worker holds, of the verb `V`, from its claim until it settles
/// it. `complete`, `fail` and `cancel` take it by value: each says the outcome
/// and releases the job together, and there is no settling it twice. A settle
/// the gateway did not take still releases the job, and is the error
/// returned.
pub struct Held<V> {
    core: Core,
    verb: PhantomData<fn() -> V>,
}

/// A `mark` job this worker holds.
pub type HeldMarkJob = Held<Mark>;
/// A `yield` job this worker holds.
pub type HeldYieldJob = Held<Yield>;

impl<V> Held<V> {
    pub fn job_id(&self) -> &JobId {
        &self.core.holding.job_id
    }

    pub fn job_type(&self) -> JobType {
        self.core.holding.job_type
    }

    pub fn resource_id(&self) -> &ResourceId {
        &self.core.holding.resource_id
    }

    /// The job's parameters as the dispatcher holds them: the description,
    /// and what the dispatcher adds.
    pub fn params(&self) -> &JobParams {
        &self.core.params
    }

    /// The units earlier attempts finished. A worker does not do them again.
    /// Empty on a first attempt.
    pub fn completed_units(&self) -> &[String] {
        &self.core.completed_units
    }

    /// How far each unit begun and not finished got on an earlier attempt.
    /// Empty on a first attempt.
    pub fn unit_cursors(&self) -> &BTreeMap<String, UnitCursor> {
        &self.core.unit_cursors
    }

    pub fn retry_count(&self) -> u64 {
        self.core.holding.budget.retry_count
    }

    pub fn max_retries(&self) -> u64 {
        self.core.holding.budget.max_retries
    }

    /// Which attempt this is, 1-based. Every lifecycle message states it.
    pub fn attempt(&self) -> i64 {
        self.core.holding.attempt
    }

    /// The annotation the job is anchored to: the one a `yield` job's
    /// context is focused on.
    pub fn annotation_id(&self) -> Option<&AnnotationId> {
        self.core.holding.annotation_id.as_ref()
    }

    /// Whether a cancellation has named this job: the current answer, and
    /// the change to it. The work stops where it can, and the worker says
    /// `cancel`.
    pub fn cancelled(&self) -> watch::Receiver<bool> {
        self.core.holding.cancelled.subscribe()
    }

    /// `job:start`: the job's first message, said once.
    pub async fn start(&self) -> Result<(), SemiontError> {
        self.core.unsettled(JobStart::NAME)?;
        if self.core.begun.swap(true, Ordering::SeqCst) {
            return Err(here(format!(
                "job:start is a held job's first message, said once: job {} has already said more",
                self.job_id()
            )));
        }
        let holding = &self.core.holding;
        let started = JobStartCommand {
            annotation_id: holding.annotation_id.clone(),
            attempt: Some(holding.attempt),
            ..JobStartCommand::new(
                holding.resource_id.clone(),
                holding.job_id.clone(),
                holding.job_type,
            )
        };
        self.core
            .inner
            .wire
            .emit::<JobStart>(&started, Envelope::default())
            .await?;
        Ok(())
    }

    /// `job:report-progress`. Counts as activity.
    pub async fn progress(&self, progress: JobProgress) -> Result<(), SemiontError> {
        self.core.unsettled(JobReportProgress::NAME)?;
        self.core.begun.store(true, Ordering::SeqCst);
        self.core.inner.active();
        let holding = &self.core.holding;
        let percentage = progress.percentage;
        let reported = JobReportProgressCommand {
            attempt: Some(holding.attempt),
            annotation_id: holding.annotation_id.clone(),
            progress: Some(JobProgress {
                annotation_id: holding
                    .annotation_id
                    .clone()
                    .or(progress.annotation_id.clone()),
                ..progress
            }),
            ..JobReportProgressCommand::new(
                holding.resource_id.clone(),
                holding.job_id.clone(),
                holding.job_type,
                percentage,
            )
        };
        self.core
            .inner
            .wire
            .emit::<JobReportProgress>(&reported, Envelope::default())
            .await?;
        Ok(())
    }

    /// `job:checkpoint`: what a later attempt resumes from. The units
    /// finished, and how far each unit begun and not finished got. Counts as
    /// activity.
    pub async fn checkpoint(
        &self,
        completed_units: Vec<String>,
        unit_cursors: Option<BTreeMap<String, UnitCursor>>,
    ) -> Result<(), SemiontError> {
        self.core.unsettled(JobCheckpoint::NAME)?;
        self.core.begun.store(true, Ordering::SeqCst);
        self.core.inner.active();
        let reached = JobCheckpointCommand {
            unit_cursors,
            ..JobCheckpointCommand::new(self.job_id().clone(), completed_units)
        };
        self.core
            .inner
            .wire
            .emit::<JobCheckpoint>(&reached, Envelope::default())
            .await?;
        Ok(())
    }

    /// `mark:commit` for this job: a batch of annotations on `resource_id`.
    /// It returns `Ok` once the batch is established.
    ///
    /// It sends the batch to the record and WAITS for the record to say it
    /// has it. The gateway taking the message says nothing of the record: a
    /// record that is down discards a batch the gateway accepted, and a job
    /// that counted the batch as done would report work that never landed.
    ///
    /// A commit the record does not acknowledge in time is not thereby lost.
    /// If the gateway goes down after the record appended the batch, the
    /// acknowledgement cannot be routed, and a job failed on that would be
    /// failed over annotations that are on the record. So the outcome follows
    /// what the record holds, and not the arrival of a message: the record
    /// is asked. A batch is never sent a second time to find out. That would
    /// double the work, and where the acknowledgement was lost because the
    /// gateway is down, the second commit would only time out as the first
    /// did.
    ///
    /// A commit that was not established fails as its unanswered request
    /// did, with that request's own failure. What was observed leaves by the
    /// job's settle, the one place it can still be told.
    pub async fn commit(
        &self,
        resource_id: &ResourceId,
        annotations: Vec<Annotation>,
    ) -> Result<(), SemiontError> {
        self.core.unsettled(MarkCommit::NAME)?;
        // A batch of no annotations is no commit: there is nothing to establish.
        let Some(last) = annotations.last().map(|last| last.id.clone()) else {
            return Ok(());
        };
        let (inner, holding) = (&self.core.inner, &self.core.holding);
        let batch = MarkCommitCommand {
            job_id: Some(holding.job_id.clone()),
            ..MarkCommitCommand::new(resource_id.clone(), annotations)
        };
        let unanswered = match inner.ask::<MarkCommit>(&batch).await {
            Ok(()) => {
                holding.observe(DurabilityEvidence::Acknowledged);
                return Ok(());
            }
            // The record's refusal, and every other failure of the request,
            // is the commit's failure as it is. Only an acknowledgement that
            // did not arrive leaves what the record holds unknown.
            Err(SemiontError::Bus(unanswered))
                if unanswered.code == BusRequestErrorCode::Timeout =>
            {
                unanswered
            }
            Err(failed) => return Err(failed),
        };
        let observed = inner.ask_whether_recorded(resource_id, last).await;
        holding.observe(observed);
        if observed == DurabilityEvidence::ProbeConfirmed {
            Ok(())
        } else {
            Err(unanswered.into())
        }
    }

    /// Settle: `job:fail`. It says whether the queue will retry, from the
    /// record's budget and the failure's class, and what a commit that was
    /// not established observed.
    pub async fn fail(
        self,
        error: impl Into<String>,
        failure: JobFailure,
    ) -> Result<(), SemiontError> {
        let failed = self.core.holding.fail(&error.into(), failure);
        self.core.settle::<JobFail>(failed, false).await
    }

    /// Settle: `job:cancel`, once the work has stopped for a cancellation,
    /// with the units it finished and how far the others got.
    pub async fn cancel(
        self,
        completed_units: Option<Vec<String>>,
        unit_cursors: Option<BTreeMap<String, UnitCursor>>,
    ) -> Result<(), SemiontError> {
        let holding = &self.core.holding;
        let cancelled = JobCancelCommand {
            annotation_id: holding.annotation_id.clone(),
            completed_units,
            unit_cursors,
            ..JobCancelCommand::new(
                holding.resource_id.clone(),
                holding.job_id.clone(),
                holding.job_type,
            )
        };
        self.core.settle::<JobCancel>(cancelled, false).await
    }
}

impl Held<Mark> {
    /// Settle: `job:complete`, with what a `mark` job reports, and how its
    /// commits were established.
    pub async fn complete(self, result: MarkJobResult) -> Result<(), SemiontError> {
        let holding = &self.core.holding;
        let completed = MarkJobCompleteCommand {
            attempt: Some(holding.attempt),
            result: Some(result),
            durability: holding.observed(),
            ..MarkJobCompleteCommand::new(holding.resource_id.clone(), holding.job_id.clone())
        };
        self.core
            .settle::<JobComplete>(JobCompleteCommand::MarkJobCompleteCommand(completed), true)
            .await
    }
}

impl Held<Yield> {
    /// Settle: `job:complete`, with what a `yield` job reports, and how its
    /// commits were established.
    pub async fn complete(self, result: YieldJobResult) -> Result<(), SemiontError> {
        let holding = &self.core.holding;
        let completed = YieldJobCompleteCommand {
            attempt: Some(holding.attempt),
            annotation_id: holding.annotation_id.clone(),
            result: Some(result),
            durability: holding.observed(),
            ..YieldJobCompleteCommand::new(holding.resource_id.clone(), holding.job_id.clone())
        };
        self.core
            .settle::<JobComplete>(JobCompleteCommand::YieldJobCompleteCommand(completed), true)
            .await
    }
}

/// A job this worker holds, as its verb's: a completion is its verb's, so
/// the verb is matched before `complete` is called. What every held job has,
/// whatever its verb, is also here.
pub enum HeldJob {
    Mark(HeldMarkJob),
    Yield(HeldYieldJob),
}

/// The same call on a held job of either verb.
macro_rules! either {
    ($held:expr, $job:ident => $call:expr) => {
        match $held {
            HeldJob::Mark($job) => $call,
            HeldJob::Yield($job) => $call,
        }
    };
}

impl HeldJob {
    /// Whether the job is settled already: its worker stopped, and failed
    /// it, before it was handed out.
    fn settled(&self) -> bool {
        either!(self, job => job.core.holding.settled.load(Ordering::SeqCst))
    }

    pub fn job_id(&self) -> &JobId {
        either!(self, job => job.job_id())
    }

    pub fn job_type(&self) -> JobType {
        either!(self, job => job.job_type())
    }

    pub fn resource_id(&self) -> &ResourceId {
        either!(self, job => job.resource_id())
    }

    pub fn params(&self) -> &JobParams {
        either!(self, job => job.params())
    }

    pub fn completed_units(&self) -> &[String] {
        either!(self, job => job.completed_units())
    }

    pub fn unit_cursors(&self) -> &BTreeMap<String, UnitCursor> {
        either!(self, job => job.unit_cursors())
    }

    pub fn retry_count(&self) -> u64 {
        either!(self, job => job.retry_count())
    }

    pub fn max_retries(&self) -> u64 {
        either!(self, job => job.max_retries())
    }

    pub fn attempt(&self) -> i64 {
        either!(self, job => job.attempt())
    }

    pub fn annotation_id(&self) -> Option<&AnnotationId> {
        either!(self, job => job.annotation_id())
    }

    pub fn cancelled(&self) -> watch::Receiver<bool> {
        either!(self, job => job.cancelled())
    }

    pub async fn start(&self) -> Result<(), SemiontError> {
        either!(self, job => job.start().await)
    }

    pub async fn progress(&self, progress: JobProgress) -> Result<(), SemiontError> {
        either!(self, job => job.progress(progress).await)
    }

    pub async fn checkpoint(
        &self,
        completed_units: Vec<String>,
        unit_cursors: Option<BTreeMap<String, UnitCursor>>,
    ) -> Result<(), SemiontError> {
        either!(self, job => job.checkpoint(completed_units, unit_cursors).await)
    }

    pub async fn commit(
        &self,
        resource_id: &ResourceId,
        annotations: Vec<Annotation>,
    ) -> Result<(), SemiontError> {
        either!(self, job => job.commit(resource_id, annotations).await)
    }

    pub async fn fail(
        self,
        error: impl Into<String>,
        failure: JobFailure,
    ) -> Result<(), SemiontError> {
        either!(self, job => job.fail(error, failure).await)
    }

    pub async fn cancel(
        self,
        completed_units: Option<Vec<String>>,
        unit_cursors: Option<BTreeMap<String, UnitCursor>>,
    ) -> Result<(), SemiontError> {
        either!(self, job => job.cancel(completed_units, unit_cursors).await)
    }
}

/// The annotation a job is anchored to: the one a `yield` job's context is
/// focused on. A `yield` job focused on a resource has none, and neither has
/// a `mark` job.
fn anchor_of(job_type: JobType, params: &JobParams) -> Option<AnnotationId> {
    if job_type != JobType::Yield {
        return None;
    }
    let focus = params.rest.get("context")?.get("focus")?;
    if focus.get("kind")?.as_str()? != "annotation" {
        return None;
    }
    focus.get("annotation")?.get("id")?.as_str()?.parse().ok()
}

/// Hold the job a claim was answered with, as its verb's.
fn held(inner: &Arc<Inner>, claimed: JobRunning) -> (Arc<Holding>, HeldJob) {
    let JobRunning {
        metadata, params, ..
    } = claimed;
    let holding = Arc::new(Holding {
        resource_id: params.resource_id.clone(),
        job_id: metadata.id.clone(),
        job_type: metadata.r#type,
        attempt: i64::try_from(metadata.retry_count)
            .unwrap_or(i64::MAX)
            .saturating_add(1),
        annotation_id: anchor_of(metadata.r#type, &params),
        settled: AtomicBool::new(false),
        cancelled: watch::channel(false).0,
        durability: Mutex::new(None),
        budget: metadata.clone(),
    });
    let core = Core {
        inner: inner.clone(),
        holding: holding.clone(),
        params,
        // Both appear on the record once an attempt has checkpointed. Absent,
        // each reads as none.
        completed_units: metadata.completed_units.unwrap_or_default(),
        unit_cursors: metadata.unit_cursors.unwrap_or_default(),
        begun: AtomicBool::new(false),
    };
    let job = match holding.job_type {
        JobType::Mark => HeldJob::Mark(Held {
            core,
            verb: PhantomData,
        }),
        JobType::Yield => HeldJob::Yield(Held {
            core,
            verb: PhantomData,
        }),
    };
    (holding, job)
}

// ── The loop ────────────────────────────────────────────────────────────

enum ClaimOutcome {
    Job(Arc<Holding>, Box<HeldJob>),
    Declined,
    Refused(ClaimRefusal),
}

/// Ask once. A claim names fields of the job description, never a job id. A
/// reply that does not read as a claimed job is refused here and never run
/// (WORKER-CONTRACT C9): it names no job id, no job type or no parameters.
async fn claim_next(inner: Arc<Inner>) -> ClaimOutcome {
    let claim = JobClaimCommand::new(inner.accepts.clone());
    match inner
        .wire
        .request::<JobClaim>(&claim, inner.timing.job_claim)
        .await
    {
        Ok(claimed) => {
            let (holding, job) = held(&inner, claimed.response);
            ClaimOutcome::Job(holding, Box::new(job))
        }
        Err(SemiontError::Bus(refused)) if refused.code == BusRequestErrorCode::NonePending => {
            ClaimOutcome::Declined
        }
        Err(SemiontError::Bus(refused)) => ClaimOutcome::Refused(ClaimRefusal {
            code: Some(refused.code),
            message: refused.message,
        }),
        Err(other) => ClaimOutcome::Refused(ClaimRefusal {
            code: None,
            message: other.to_string(),
        }),
    }
}

type Claiming = Pin<Box<dyn Future<Output = ClaimOutcome> + Send>>;

/// The claim in flight, answered; or never, when none is.
async fn answered(claim: &mut Option<Claiming>) -> ClaimOutcome {
    match claim {
        Some(claim) => claim.as_mut().await,
        None => std::future::pending().await,
    }
}

type Handed = Result<HeldJob, ClaimRefusal>;

/// One worker's claiming, from the first read of its claims until it stops,
/// its reader is gone, or its stream has ended.
async fn run(inner: Arc<Inner>, out: mpsc::Sender<Handed>, mut stop: watch::Receiver<bool>) {
    let transport = inner.wire.transport().clone();
    // A worker on a stream that does not name these would never be answered,
    // woken or told of a cancellation, with nothing to show for it.
    let unnamed: Vec<&str> = JOB_CLAIM_CHANNELS
        .iter()
        .copied()
        .filter(|channel| !transport.is_subscribed(channel))
        .collect();
    // Both broadcasts are read as they come, and not as this SDK types them:
    // the comparison of an announcement with a filter knows no field by
    // name, so a job this SDK cannot type still wakes a worker whose claim it
    // matches.
    let streams = (
        inner.wire.frames_on(JobQueued::NAME),
        inner.wire.frames_on(JobCancelRequested::NAME),
    );
    let (mut queued, mut cancels) = match streams {
        (Ok(queued), Ok(cancels)) if unnamed.is_empty() => (queued, cancels),
        _ => {
            let _ = out
                .send(Err(ClaimRefusal {
                    code: Some(BusRequestErrorCode::Unsubscribed),
                    message: format!(
                        "This transport's stream does not name {}: a worker on it would never be answered, woken or told of a cancellation. Give the transport JOB_CLAIM_CHANNELS.",
                        if unnamed.is_empty() { JOB_CLAIM_CHANNELS.join(", ") } else { unnamed.join(", ") }
                    ),
                }))
                .await;
            return;
        }
    };

    // The stream opening again is an edge into `Open` after the first
    // observation. The first observation decides whether the first claim is
    // made now or waits for the stream to open: a claim on a closed stream
    // would only be refused here.
    let mut state = transport.state();
    let mut was_open = *state.borrow_and_update() == ConnectionState::Open;
    // An idle moment asks for a claim. One claim is in flight at a time, and
    // a wake-up that arrives during it is honoured with exactly one more.
    let mut want = was_open;
    let mut wake_pending = false;
    let mut claim: Option<Claiming> = None;
    let check = inner.timing.held_job_stall_check;
    let mut stall = tokio::time::interval_at(Instant::now() + check, check);
    stall.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        if want {
            want = false;
            if inner.holding() {
                // Holding a job: the settle claims. Nothing to remember.
            } else if claim.is_some() {
                wake_pending = true;
            } else {
                wake_pending = false;
                claim = Some(Box::pin(claim_next(inner.clone())));
            }
        }
        tokio::select! {
            biased;
            _ = stop.changed() => break,
            _ = out.closed() => break,
            outcome = answered(&mut claim) => {
                claim = None;
                let again = match outcome {
                    ClaimOutcome::Job(holding, job) => {
                        inner.hold(&holding);
                        // With no reader left the job is dropped, which fails it.
                        if out.send(Ok(*job)).await.is_err() {
                            break;
                        }
                        // A wake-up that arrived during the claim is moot: the settle claims.
                        false
                    }
                    ClaimOutcome::Declined => wake_pending,
                    ClaimOutcome::Refused(refusal) => {
                        if out.send(Err(refusal)).await.is_err() {
                            break;
                        }
                        wake_pending
                    }
                };
                wake_pending = false;
                want = again;
            }
            announced = queued.next() => match announced {
                Some(Ok(announced)) => {
                    // Every announcement received is stamped, before any filtering.
                    locked(&inner.state).last_queued_event_at = Some(SystemTime::now());
                    let announced = Value::Object(announced.payload);
                    want = inner
                        .accepts
                        .iter()
                        .any(|filter| job_matches_filter(filter, &announced));
                }
                // The stream fell behind, and what it missed may have been a
                // wake-up: the queue is asked.
                Some(Err(_)) => want = true,
                None => break,
            },
            request = cancels.next() => match request {
                Some(Ok(request)) => {
                    if let Some(job_id) = request.payload.get("jobId").and_then(Value::as_str) {
                        inner.signal_cancellation(job_id);
                    }
                }
                Some(Err(_)) => {}
                None => break,
            },
            changed = state.changed() => {
                if changed.is_err() {
                    break;
                }
                let open = *state.borrow_and_update() == ConnectionState::Open;
                want = open && !was_open;
                was_open = open;
            }
            _ = inner.settled.notified() => want = true,
            _ = stall.tick() => inner.look_for_stall(),
        }
    }

    // A claim still in flight may yet be answered with a job, which is this
    // worker's at the dispatcher from that moment, with nobody here left to
    // run it: it is failed, and not left held by nobody.
    if let Some(claim) = claim
        && let ClaimOutcome::Job(holding, job) = claim.await
    {
        inner.fail_held(&holding, STOPPED_WHILE_HELD).await;
        drop(job);
    }
}

/// A worker's claims, from `job.claim`: each job the worker comes to hold,
/// one at a time, and each claim that was refused. The next job is claimed
/// when the one held is settled.
///
/// Claiming begins when the claims are first read (`next`). It ends when
/// `stop` is called, when the claims are dropped, or when the transport's
/// stream ends.
///
/// Every method takes `&self`, so one task can read the claims while another
/// reads the worker's vitals, watches for a stall, or stops it. Two readers
/// take turns: a job is handed to one of them.
pub struct Claims {
    inner: Arc<Inner>,
    /// What the claiming hands out through, until the claiming has begun.
    out: Mutex<Option<mpsc::Sender<Handed>>>,
    handed: tokio::sync::Mutex<mpsc::Receiver<Handed>>,
    stop: watch::Sender<bool>,
}

impl Claims {
    pub(crate) fn new(wire: Bus, options: ClaimOptions) -> Claims {
        let (out, handed) = mpsc::channel(1);
        Claims {
            inner: Arc::new(Inner {
                wire,
                accepts: options.accepts,
                timing: options.timing,
                state: Mutex::new(State::default()),
                settled: Notify::new(),
                stall: watch::channel(None).0,
            }),
            out: Mutex::new(Some(out)),
            handed: tokio::sync::Mutex::new(handed),
            stop: watch::channel(false).0,
        }
    }

    /// The next job this worker holds, or the next claim it was refused.
    /// `None` once the claiming has ended. A refusal does not end it: the
    /// worker waits for its next idle moment, and what the refusal means is
    /// its host's to judge.
    pub async fn next(&self) -> Option<Handed> {
        let out = locked(&self.out).take();
        if let Some(out) = out {
            tokio::spawn(run(self.inner.clone(), out, self.stop.subscribe()));
        }
        let mut handed = self.handed.lock().await;
        loop {
            match handed.recv().await {
                // Claimed, and failed by the worker's stop before anybody read it.
                Some(Ok(job)) if job.settled() => {}
                next => return next,
            }
        }
    }

    /// What this worker can say of itself now.
    pub fn vitals(&self) -> WorkerVitals {
        self.inner.vitals()
    }

    /// The last stall found: a held job that has shown no activity for
    /// `held_job_stall`, reported once. `None` until there is one, and each
    /// one after is a change.
    pub fn stalled(&self) -> watch::Receiver<Option<HeldJobStall>> {
        self.inner.stall.subscribe()
    }

    /// Stop claiming. A job still held is failed first, and this returns
    /// once that has been said, or could not be.
    pub async fn stop(&self) {
        // Claiming that never began never will, and what was begun ends:
        // either way nothing more is handed out.
        drop(locked(&self.out).take());
        self.stop.send_replace(true);
        let held = locked(&self.inner.state).held.clone();
        if let Some(holding) = held {
            self.inner.fail_held(&holding, STOPPED_WHILE_HELD).await;
        }
    }
}
