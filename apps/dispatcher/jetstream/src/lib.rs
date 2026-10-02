//! The dispatcher's job queue on NATS JetStream, behind the handlers'
//! `JobQueue` contract. Nothing of the broker leaves this crate.
//!
//! Two primitives, one authority each (docs/protocol/JOBS.md § Storage):
//!
//! - **The key-value bucket** holds the authoritative record of every job
//!   (`JobRecord`: the job, and the liveness time the dead-worker sweep
//!   reads). Every transition is a compare-and-swap on the record's revision,
//!   which is what makes a claim atomic.
//! - **The work-queue stream** delivers jobs to the dispatcher. A delivered
//!   message is the dispatcher's lease on its job: extended while it lives,
//!   settled when the job ends, and redelivered after the acknowledgement
//!   window when the dispatcher that held it stops.
//!
//! The layout — stream, subjects, consumer, bucket — is specs/src/jobs/storage.json's.

#![forbid(unsafe_code)]

use async_nats::jetstream::{self, AckKind, consumer::pull, kv, stream};
use bytes::Bytes;
use futures::StreamExt;
use semiont::types::{
    FailureClass, Job, JobCancelRequestJobType, JobCancelled, JobCancelledStatus, JobComplete,
    JobCompleteStatus, JobFailed, JobFailedStatus, JobId, JobPending, JobPendingStatus,
    JobQueuedEvent, JobRunning, JobRunningStatus, JobStoredProgress, JobStoredResult, JobType,
};
use semiont_core::nats::{self, Voice};
use semiont_core::types::JobRecord;
use semiont_dispatcher_handlers::admission::{now, wire_name};
use semiont_dispatcher_handlers::checkpoint::{checkpointed, failed_with};
use semiont_dispatcher_handlers::queue::{
    Checkpoint, Claim, FailOutcome, JobQueue, QueueError, Stats,
};
use semiont_dispatcher_handlers::retry::will_retry_after;
use semiont_observability::logging;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;

include!(concat!(env!("OUT_DIR"), "/storage.rs"));

/// Past this many revision conflicts on one transition, something is wrong.
const MAX_CAS_ATTEMPTS: usize = 20;

/// The broker, and the queue's clocks (the dispatcher's document's `queue` and `timing`).
pub struct Settings {
    pub servers: String,
    pub user: Option<String>,
    pub password: Option<String>,
    pub tick: Duration,
    pub stale_running: Duration,
    pub ack_wait: Duration,
    pub retention: Duration,
    pub retention_sweep: Duration,
    pub progress_write_interval: Duration,
}

fn failed(what: &str, error: impl std::fmt::Display) -> QueueError {
    QueueError(format!("{what}: {error}"))
}

/// The subject a job of this type is published on.
/// A stored value as the record it is, or why it is not one.
fn decode(id: &str, stored: &[u8]) -> Result<JobRecord, QueueError> {
    serde_json::from_slice(stored).map_err(|e| failed(&format!("job {id}'s record"), e))
}

/// What a pass over every job makes of one stored value: its record, or
/// nothing for a value that does not decode. That one is reported and passed
/// over, at every pass, and is never claimed, counted, swept or pruned: were
/// it the pass's failure instead, one bad record would stop every claim and
/// every sweep of the jobs listed after it.
fn scanned(id: &str, stored: &[u8]) -> Option<JobRecord> {
    match decode(id, stored) {
        Ok(record) => Some(record),
        Err(error) => {
            logging::error(
                "A stored job record that does not decode",
                json!({ "component": "job-queue", "jobId": id, "error": error.0 }),
            );
            None
        }
    }
}

fn subject(job_type: JobType) -> String {
    let name = wire_name(job_type);
    let category = JOB_CATEGORIES
        .iter()
        .find(|(_, types)| types.contains(&name.as_str()))
        .map(|(category, _)| *category)
        .unwrap_or_else(|| panic!("job type {name} has no category in the job storage layout"));
    format!("{JOBS_SUBJECT_ROOT}.{category}.{name}")
}

fn metadata_of(job: &Job) -> &semiont::types::JobMetadata {
    match job {
        Job::Pending(j) => &j.metadata,
        Job::Running(j) => &j.metadata,
        Job::Complete(j) => &j.metadata,
        Job::Failed(j) => &j.metadata,
        Job::Cancelled(j) => &j.metadata,
    }
}

fn is_terminal(job: &Job) -> bool {
    matches!(job, Job::Complete(_) | Job::Failed(_) | Job::Cancelled(_))
}

/// What a transition does with the record it read.
enum Transition<T> {
    /// Write this job, with its liveness now, and answer `T`.
    Write(Box<Job>, T),
    /// Leave the record as it is and answer `T`.
    Keep(T),
}

/// A delivery this dispatcher holds: the lease, and the job's type, so a
/// claim by type can walk them without a read.
struct Held {
    message: jetstream::Message,
    job_type: JobType,
}

struct Inner {
    client: async_nats::Client,
    context: jetstream::Context,
    kv: kv::Store,
    stream: stream::Stream,
    held: Mutex<HashMap<String, Held>>,
    last_progress_write: Mutex<HashMap<String, Instant>>,
    announce: UnboundedSender<JobQueuedEvent>,
    settings: Settings,
}

pub struct JetStreamQueue {
    inner: Arc<Inner>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for JetStreamQueue {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl JetStreamQueue {
    /// Connect to the broker, make the stream, consumer and bucket if they are
    /// missing, and start taking deliveries and running the clocks. Each
    /// pending job delivered is announced on `announce`.
    pub async fn connect(
        settings: Settings,
        announce: UnboundedSender<JobQueuedEvent>,
    ) -> Result<JetStreamQueue, QueueError> {
        let client = nats::connect(
            &settings.servers,
            settings.user.clone(),
            settings.password.clone(),
            Voice {
                tag: "jobs",
                while_down: "queue operations fail until reconnect",
                refused: "the dispatcher",
            },
        )
        .await
        .map_err(|e| QueueError(e.to_string()))?;
        let context = jetstream::new(client.clone());
        let kv = match context.get_key_value(JOBS_BUCKET).await {
            Ok(kv) => kv,
            Err(_) => context
                .create_key_value(kv::Config {
                    bucket: JOBS_BUCKET.to_owned(),
                    history: 1,
                    ..Default::default()
                })
                .await
                .map_err(|e| failed("opening the job bucket", e))?,
        };
        let stream = context
            .get_or_create_stream(stream::Config {
                name: JOBS_STREAM.to_owned(),
                subjects: vec![format!("{JOBS_SUBJECT_ROOT}.>")],
                retention: stream::RetentionPolicy::WorkQueue,
                ..Default::default()
            })
            .await
            .map_err(|e| failed("opening the job stream", e))?;
        let consumer = stream
            .get_or_create_consumer(
                JOBS_CONSUMER,
                pull::Config {
                    durable_name: Some(JOBS_CONSUMER.to_owned()),
                    ack_policy: jetstream::consumer::AckPolicy::Explicit,
                    deliver_policy: jetstream::consumer::DeliverPolicy::All,
                    ack_wait: settings.ack_wait,
                    // One retry authority: the retry rule decides; the stream
                    // never gives up a message on its own count.
                    max_deliver: -1,
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| failed("opening the job consumer", e))?;
        let mut messages = consumer
            .messages()
            .await
            .map_err(|e| failed("taking job deliveries", e))?;

        let inner = Arc::new(Inner {
            client,
            context,
            kv,
            stream,
            held: Mutex::new(HashMap::new()),
            last_progress_write: Mutex::new(HashMap::new()),
            announce,
            settings,
        });
        let mut tasks = Vec::new();
        let deliveries = inner.clone();
        tasks.push(tokio::spawn(async move {
            while let Some(message) = messages.next().await {
                match message {
                    Ok(message) => {
                        let inner = deliveries.clone();
                        tokio::spawn(async move { inner.on_delivery(message).await });
                    }
                    Err(error) => logging::warn(
                        "Job delivery failed",
                        json!({ "component": "job-queue", "error": error.to_string() }),
                    ),
                }
            }
        }));
        let heartbeat = inner.clone();
        let beat = (heartbeat.settings.ack_wait / 4).max(Duration::from_millis(250));
        tasks.push(tokio::spawn(async move {
            let mut every = tokio::time::interval(beat);
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                every.tick().await;
                heartbeat.reconcile_held().await;
            }
        }));
        let tick = inner.clone();
        tasks.push(tokio::spawn(async move {
            let mut every = tokio::time::interval(tick.settings.tick);
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            every.tick().await;
            loop {
                every.tick().await;
                if let Err(error) = tick.tick().await {
                    logging::warn(
                        "Job-queue tick failed",
                        json!({ "component": "job-queue", "error": error.0 }),
                    );
                }
            }
        }));
        let retention = inner.clone();
        tasks.push(tokio::spawn(async move {
            let mut every = tokio::time::interval(retention.settings.retention_sweep);
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            every.tick().await;
            loop {
                every.tick().await;
                if let Err(error) = retention.prune_terminal_jobs().await {
                    logging::warn(
                        "Job retention cleanup failed",
                        json!({ "component": "job-queue", "error": error.0 }),
                    );
                }
            }
        }));
        Ok(JetStreamQueue { inner, tasks })
    }
}

impl Inner {
    /// Refuse at once while the broker is away, rather than wait out a
    /// request the client holds until it reconnects.
    fn connected(&self) -> Result<(), QueueError> {
        match self.client.connection_state() {
            async_nats::connection::State::Connected => Ok(()),
            _ => Err(QueueError(format!(
                "the job queue's broker at {} is not connected",
                self.settings.servers
            ))),
        }
    }

    fn held(&self) -> std::sync::MutexGuard<'_, HashMap<String, Held>> {
        self.held.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// What the bucket holds under `id`, and its revision.
    async fn stored(&self, id: &str) -> Result<Option<(Bytes, u64)>, QueueError> {
        self.connected()?;
        let Some(entry) = self
            .kv
            .entry(id)
            .await
            .map_err(|e| failed("reading a job", e))?
        else {
            return Ok(None);
        };
        if entry.operation != kv::Operation::Put {
            return Ok(None);
        }
        Ok(Some((entry.value, entry.revision)))
    }

    /// A named job's record. One that does not decode is the failure.
    async fn read(&self, id: &str) -> Result<Option<(JobRecord, u64)>, QueueError> {
        let Some((stored, revision)) = self.stored(id).await? else {
            return Ok(None);
        };
        Ok(Some((decode(id, &stored)?, revision)))
    }

    /// One record of a pass over every job. One that does not decode is
    /// reported and passed over (`scanned`).
    async fn scan(&self, id: &str) -> Result<Option<JobRecord>, QueueError> {
        Ok(self
            .stored(id)
            .await?
            .and_then(|(stored, _)| scanned(id, &stored)))
    }

    fn encode(job: Job) -> Bytes {
        let record = JobRecord {
            job,
            last_progress_at: now(),
        };
        Bytes::from(serde_json::to_vec(&record).expect("a job record serializes"))
    }

    /// Read, transform, and write only if nothing wrote in between; read again
    /// on a conflict. `missing` answers for a job with no record.
    async fn cas<T>(
        &self,
        id: &str,
        missing: T,
        mut transform: impl FnMut(&JobRecord) -> Transition<T>,
    ) -> Result<T, QueueError> {
        for _ in 0..MAX_CAS_ATTEMPTS {
            let Some((record, revision)) = self.read(id).await? else {
                return Ok(missing);
            };
            match transform(&record) {
                Transition::Keep(answer) => return Ok(answer),
                Transition::Write(job, answer) => {
                    if self
                        .kv
                        .update(id, Self::encode(*job), revision)
                        .await
                        .is_ok()
                    {
                        return Ok(answer);
                    }
                }
            }
        }
        Err(QueueError(format!(
            "Job {id} transition failed after {MAX_CAS_ATTEMPTS} CAS attempts"
        )))
    }

    /// Every key in the bucket, gathered before any is read.
    async fn all_keys(&self) -> Result<Vec<String>, QueueError> {
        self.connected()?;
        let mut keys = self
            .kv
            .keys()
            .await
            .map_err(|e| failed("listing jobs", e))?;
        let mut all = Vec::new();
        while let Some(key) = keys.next().await {
            all.push(key.map_err(|e| failed("listing jobs", e))?);
        }
        Ok(all)
    }

    fn announce(&self, job: &Job) {
        let metadata = metadata_of(job);
        let resource_id = match job {
            Job::Pending(j) => &j.params.resource_id,
            Job::Running(j) => &j.params.resource_id,
            Job::Complete(j) => &j.params.resource_id,
            Job::Failed(j) => &j.params.resource_id,
            Job::Cancelled(j) => &j.params.resource_id,
        };
        let _ = self.announce.send(JobQueuedEvent {
            job_id: metadata.id.clone(),
            job_type: wire_name(metadata.r#type),
            resource_id: resource_id.clone(),
            user_id: metadata.user_id.clone(),
        });
    }

    /// A delivery: held and announced when the job is pending, held silently
    /// when it is running, consumed when it is concluded, terminated when the
    /// queue has no record of it.
    async fn on_delivery(&self, message: jetstream::Message) {
        let id = serde_json::from_slice::<serde_json::Value>(&message.payload)
            .ok()
            .and_then(|v| v["jobId"].as_str().map(str::to_owned));
        let Some(id) = id else {
            let _ = message.ack_with(AckKind::Term).await;
            return;
        };
        let record = match self.read(&id).await {
            Ok(record) => record,
            Err(error) => {
                logging::warn(
                    "Job delivery handling failed",
                    json!({ "component": "job-queue", "error": error.0 }),
                );
                return;
            }
        };
        let Some((record, _)) = record else {
            let _ = message.ack_with(AckKind::Term).await;
            return;
        };
        match &record.job {
            Job::Pending(pending) => {
                let job_type = pending.metadata.r#type;
                self.held().insert(id, Held { message, job_type });
                self.announce(&record.job);
            }
            Job::Running(running) => {
                let job_type = running.metadata.r#type;
                self.held().insert(id, Held { message, job_type });
            }
            _ => {
                self.held().remove(&id);
                let _ = message.ack().await;
            }
        }
    }

    /// Conclude this dispatcher's lease on a job, if it holds one.
    async fn settle(&self, id: &str, how: AckKind) {
        let held = self.held().remove(id);
        if let Some(held) = held {
            let _ = held.message.ack_with(how).await;
        }
    }

    /// Extend every live lease; settle the ones whose jobs concluded.
    async fn reconcile_held(&self) {
        let ids: Vec<String> = self.held().keys().cloned().collect();
        for id in ids {
            let Ok(record) = self.read(&id).await else {
                continue;
            };
            let concluded = record.as_ref().is_none_or(|(r, _)| is_terminal(&r.job));
            let held = if concluded {
                self.held().remove(&id)
            } else {
                None
            };
            match held {
                Some(held) => {
                    let _ = held.message.ack().await;
                }
                None if !concluded => {
                    let message = self.held().get(&id).map(|h| h.message.clone());
                    if let Some(message) = message {
                        let _ = message.ack_with(AckKind::Progress).await;
                    }
                }
                None => {}
            }
        }
    }

    /// The tick: re-announce the pending jobs this dispatcher holds, then sweep
    /// for running jobs whose worker went silent.
    async fn tick(&self) -> Result<(), QueueError> {
        let ids: Vec<String> = self.held().keys().cloned().collect();
        for id in ids {
            if let Some(record) = self.scan(&id).await?
                && matches!(record.job, Job::Pending(_))
            {
                self.announce(&record.job);
            }
        }
        self.recover_stale_running_jobs().await
    }

    async fn recover_stale_running_jobs(&self) -> Result<(), QueueError> {
        let stale = self.settings.stale_running;
        let error = format!(
            "worker presumed dead — no progress within {} minutes",
            stale.as_millis() as f64 / 60_000.0
        );
        for id in self.all_keys().await? {
            let Some(record) = self.scan(&id).await? else {
                continue;
            };
            if !matches!(record.job, Job::Running(_)) {
                continue;
            }
            let Some(age) = age_of(&record.last_progress_at) else {
                continue;
            };
            if age < stale {
                continue;
            }
            let outcome = self
                .fail(&id, error.clone(), Checkpoint::default(), None)
                .await?;
            if let Some(outcome) = outcome {
                logging::warn(
                    "Recovered stale running job",
                    json!({ "component": "job-queue", "jobId": id, "outcome": format!("{outcome:?}") }),
                );
            }
        }
        Ok(())
    }

    /// Retention: delete every concluded record past its window, leaving no
    /// marker on the bucket (a purge of the bucket's own stream, by subject).
    async fn prune_terminal_jobs(&self) -> Result<(), QueueError> {
        let retention = self.settings.retention;
        let mut pruned = 0;
        let bucket = self
            .context
            .get_stream(format!("KV_{JOBS_BUCKET}"))
            .await
            .map_err(|e| failed("opening the job bucket's stream", e))?;
        for id in self.all_keys().await? {
            let Some(record) = self.scan(&id).await? else {
                continue;
            };
            let completed_at = match &record.job {
                Job::Complete(j) => &j.completed_at,
                Job::Failed(j) => &j.completed_at,
                Job::Cancelled(j) => &j.completed_at,
                _ => continue,
            };
            if age_of(completed_at).is_some_and(|age| age <= retention) {
                continue;
            }
            bucket
                .purge()
                .filter(format!("$KV.{JOBS_BUCKET}.{id}"))
                .await
                .map_err(|e| failed("deleting a concluded job", e))?;
            self.last_progress_write
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            pruned += 1;
        }
        if pruned > 0 {
            logging::info(
                "Jobs cleaned up",
                json!({ "component": "job-queue", "deletedCount": pruned }),
            );
        }
        Ok(())
    }

    async fn try_claim(&self, id: &str) -> Result<Option<JobRunning>, QueueError> {
        self.cas(id, None, |record| match &record.job {
            Job::Pending(job) => {
                let running = JobRunning {
                    status: JobRunningStatus::Running,
                    metadata: job.metadata.clone(),
                    params: job.params.clone(),
                    started_at: now(),
                    progress: JobStoredProgress::Empty(Default::default()),
                };
                Transition::Write(Box::new(Job::Running(running.clone())), Some(running))
            }
            _ => Transition::Keep(None),
        })
        .await
    }

    async fn fail(
        &self,
        id: &str,
        error: String,
        checkpoint: Checkpoint,
        failure_class: Option<FailureClass>,
    ) -> Result<Option<FailOutcome>, QueueError> {
        let outcome = self
            .cas(id, None, |record| {
                let Job::Running(job) = &record.job else {
                    return Transition::Keep(None);
                };
                let metadata = failed_with(
                    &job.metadata,
                    &checkpoint.completed_units,
                    checkpoint.unit_cursors.as_ref(),
                );
                if will_retry_after(&job.metadata, failure_class) {
                    let retried = JobPending {
                        status: JobPendingStatus::Pending,
                        metadata: semiont::types::JobMetadata {
                            retry_count: job.metadata.retry_count + 1,
                            ..metadata
                        },
                        params: job.params.clone(),
                    };
                    return Transition::Write(
                        Box::new(Job::Pending(retried)),
                        Some(FailOutcome::Retried),
                    );
                }
                let failed = JobFailed {
                    status: JobFailedStatus::Failed,
                    metadata,
                    params: job.params.clone(),
                    started_at: Some(job.started_at.clone()),
                    completed_at: now(),
                    error: error.clone(),
                };
                Transition::Write(Box::new(Job::Failed(failed)), Some(FailOutcome::Failed))
            })
            .await?;
        match outcome {
            Some(FailOutcome::Retried) => {
                // A retry is a redelivery: the held message goes back at once;
                // one another dispatcher holds is published anew.
                let held = self.held().remove(id);
                match held {
                    Some(held) => {
                        let _ = held.message.ack_with(AckKind::Nak(None)).await;
                    }
                    None => {
                        if let Some((record, _)) = self.read(id).await? {
                            self.publish(metadata_of(&record.job).r#type, id).await?;
                        }
                    }
                }
            }
            Some(FailOutcome::Failed) => self.settle(id, AckKind::Term).await,
            None => {}
        }
        Ok(outcome)
    }

    async fn publish(&self, job_type: JobType, id: &str) -> Result<(), QueueError> {
        self.connected()?;
        let payload = Bytes::from(
            serde_json::to_vec(&json!({ "jobId": id })).expect("a delivery serializes"),
        );
        self.context
            .publish(subject(job_type), payload)
            .await
            .map_err(|e| failed("publishing a job", e))?
            .await
            .map_err(|e| failed("publishing a job", e))?;
        Ok(())
    }
}

/// How long ago an ISO 8601 time was; `None` when it does not parse.
fn age_of(time: &str) -> Option<Duration> {
    let then = chrono::DateTime::parse_from_rfc3339(time).ok()?;
    (chrono::Utc::now() - then.with_timezone(&chrono::Utc))
        .to_std()
        .ok()
        .or(Some(Duration::ZERO))
}

impl JobQueue for JetStreamQueue {
    async fn create_job(&self, job: JobPending) -> Result<(), QueueError> {
        self.inner.connected()?;
        let id = job.metadata.id.clone();
        let job_type = job.metadata.r#type;
        self.inner
            .kv
            .create(&id, Inner::encode(Job::Pending(job)))
            .await
            .map_err(|e| failed("admitting a job", e))?;
        self.inner.publish(job_type, id.as_str()).await
    }

    async fn get_job(&self, id: &JobId) -> Result<Option<Job>, QueueError> {
        Ok(self
            .inner
            .read(id.as_str())
            .await?
            .map(|(record, _)| record.job))
    }

    async fn claim_next_job(&self, types: &[String]) -> Result<Claim, QueueError> {
        let wanted =
            |job_type: JobType| types.is_empty() || types.iter().any(|t| *t == wire_name(job_type));
        let held: Vec<String> = self
            .inner
            .held()
            .iter()
            .filter(|(_, h)| wanted(h.job_type))
            .map(|(id, _)| id.clone())
            .collect();
        for id in held {
            if let Some(job) = self.inner.try_claim(&id).await? {
                return Ok(Claim::Claimed(Box::new(job)));
            }
        }
        for id in self.inner.all_keys().await? {
            let Some(record) = self.inner.scan(&id).await? else {
                continue;
            };
            let Job::Pending(job) = &record.job else {
                continue;
            };
            if !wanted(job.metadata.r#type) {
                continue;
            }
            if let Some(job) = self.inner.try_claim(&id).await? {
                return Ok(Claim::Claimed(Box::new(job)));
            }
        }
        Ok(Claim::Declined)
    }

    async fn complete_job(&self, id: &JobId, result: JobStoredResult) -> Result<bool, QueueError> {
        let moved = self
            .inner
            .cas(id.as_str(), false, |record| match &record.job {
                Job::Running(job) => Transition::Write(
                    Box::new(Job::Complete(JobComplete {
                        status: JobCompleteStatus::Complete,
                        metadata: job.metadata.clone(),
                        params: job.params.clone(),
                        started_at: job.started_at.clone(),
                        completed_at: now(),
                        result: result.clone(),
                    })),
                    true,
                ),
                _ => Transition::Keep(false),
            })
            .await?;
        if moved {
            self.inner.settle(id.as_str(), AckKind::Ack).await;
        }
        Ok(moved)
    }

    async fn fail_job(
        &self,
        id: &JobId,
        error: String,
        checkpoint: Checkpoint,
        failure_class: Option<FailureClass>,
    ) -> Result<Option<FailOutcome>, QueueError> {
        self.inner
            .fail(id.as_str(), error, checkpoint, failure_class)
            .await
    }

    async fn checkpoint_units(&self, id: &JobId, checkpoint: Checkpoint) -> Result<(), QueueError> {
        self.inner
            .cas(id.as_str(), (), |record| match &record.job {
                Job::Running(job) => {
                    let metadata = checkpointed(
                        &job.metadata,
                        &checkpoint.completed_units,
                        checkpoint.unit_cursors.as_ref(),
                    );
                    Transition::Write(
                        Box::new(Job::Running(JobRunning {
                            metadata,
                            ..job.clone()
                        })),
                        (),
                    )
                }
                _ => Transition::Keep(()),
            })
            .await
    }

    async fn record_progress(
        &self,
        id: &JobId,
        progress: JobStoredProgress,
    ) -> Result<(), QueueError> {
        let interval = self.inner.settings.progress_write_interval;
        {
            let mut writes = self
                .inner
                .last_progress_write
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if writes
                .get(id.as_str())
                .is_some_and(|last| last.elapsed() < interval)
            {
                return Ok(());
            }
            writes.insert(id.as_str().to_owned(), Instant::now());
        }
        let message = self
            .inner
            .held()
            .get(id.as_str())
            .map(|h| h.message.clone());
        if let Some(message) = message {
            let _ = message.ack_with(AckKind::Progress).await;
        }
        self.inner
            .cas(id.as_str(), (), |record| match &record.job {
                Job::Running(job) => Transition::Write(
                    Box::new(Job::Running(JobRunning {
                        progress: progress.clone(),
                        ..job.clone()
                    })),
                    (),
                ),
                _ => Transition::Keep(()),
            })
            .await
    }

    async fn cancel_pending_jobs(
        &self,
        category: JobCancelRequestJobType,
    ) -> Result<u64, QueueError> {
        let name = serde_json::to_value(category)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .expect("a category names itself");
        let types: &[&str] = JOB_CATEGORIES
            .iter()
            .find(|(c, _)| *c == name)
            .map(|(_, types)| *types)
            .unwrap_or_else(|| panic!("the job storage layout has no category {name}"));
        let in_category = |job_type: JobType| types.contains(&wire_name(job_type).as_str());
        let mut cancelled = 0;
        for id in self.inner.all_keys().await? {
            let Some(record) = self.inner.scan(&id).await? else {
                continue;
            };
            let Job::Pending(job) = &record.job else {
                continue;
            };
            if !in_category(job.metadata.r#type) {
                continue;
            }
            let done = self
                .inner
                .cas(&id, false, |record| match &record.job {
                    Job::Pending(job) if in_category(job.metadata.r#type) => Transition::Write(
                        Box::new(Job::Cancelled(JobCancelled {
                            status: JobCancelledStatus::Cancelled,
                            metadata: job.metadata.clone(),
                            params: job.params.clone(),
                            started_at: None,
                            completed_at: now(),
                        })),
                        true,
                    ),
                    _ => Transition::Keep(false),
                })
                .await?;
            if done {
                cancelled += 1;
                self.inner.settle(&id, AckKind::Term).await;
            }
        }
        self.inner
            .stream
            .purge()
            .filter(format!("{JOBS_SUBJECT_ROOT}.{name}.>"))
            .await
            .map_err(|e| failed("purging a category's deliveries", e))?;
        Ok(cancelled)
    }

    async fn cancel_job(&self, id: &JobId) -> Result<bool, QueueError> {
        let done = self
            .inner
            .cas(id.as_str(), false, |record| {
                let (metadata, params, started_at) = match &record.job {
                    Job::Pending(job) => (job.metadata.clone(), job.params.clone(), None),
                    Job::Running(job) => (
                        job.metadata.clone(),
                        job.params.clone(),
                        Some(job.started_at.clone()),
                    ),
                    _ => return Transition::Keep(false),
                };
                Transition::Write(
                    Box::new(Job::Cancelled(JobCancelled {
                        status: JobCancelledStatus::Cancelled,
                        metadata,
                        params,
                        started_at,
                        completed_at: now(),
                    })),
                    true,
                )
            })
            .await?;
        if done {
            self.inner.settle(id.as_str(), AckKind::Term).await;
        }
        Ok(done)
    }

    async fn stats(&self) -> Result<Stats, QueueError> {
        let mut stats = Stats::default();
        for id in self.inner.all_keys().await? {
            let Some(record) = self.inner.scan(&id).await? else {
                continue;
            };
            match record.job {
                Job::Pending(_) => stats.pending += 1,
                Job::Running(_) => stats.running += 1,
                Job::Complete(_) => stats.complete += 1,
                Job::Failed(_) => stats.failed += 1,
                Job::Cancelled(_) => stats.cancelled += 1,
            }
        }
        Ok(stats)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(job_id: &str, resource_id: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "job": {
                "status": "pending",
                "metadata": {
                    "id": job_id,
                    "type": "highlight-annotation",
                    "userId": "did:web:example.org:users:alice",
                    "created": "2026-10-02T00:00:00.000Z",
                    "retryCount": 0,
                    "maxRetries": 1,
                },
                "params": { "resourceId": resource_id },
            },
            "lastProgressAt": "2026-10-02T00:00:00.000Z",
        }))
        .expect("JSON")
    }

    #[test]
    fn a_pass_over_every_job_goes_on_past_a_record_that_does_not_decode() {
        let bucket = [
            ("job-1", stored("job-1", "r1")),
            ("job-2", stored("job-2", "..")),
            ("job-3", b"not a record".to_vec()),
            ("job-4", stored("job-4", "r4")),
        ];
        let passed: Vec<String> = bucket
            .iter()
            .filter_map(|(id, stored)| scanned(id, stored))
            .map(|record| metadata_of(&record.job).id.to_string())
            .collect();
        assert_eq!(passed, ["job-1", "job-4"]);
    }

    #[test]
    fn a_named_jobs_record_that_does_not_decode_is_the_failure_and_says_which() {
        let error = decode("job-2", &stored("job-2", "..")).expect_err("`..` is no ResourceId");
        assert!(error.0.starts_with("job job-2's record: "), "{}", error.0);
    }
}
