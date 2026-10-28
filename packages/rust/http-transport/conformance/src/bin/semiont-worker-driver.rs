//! The Rust worker driver for the worker conformance suite
//! (tests/conformance/worker; its README.md is the protocol): a worker's
//! claims and the jobs it holds, driven one operation per line on stdin,
//! reporting what the worker claimed, was refused, and was told on stdout.
//!
//! It reaches the worker's surface only as a worker's author does: `job.claim`
//! on the SDK's client, the claims it returns, and the held jobs they hand
//! out.
//!
//! As a worker's code does, it runs each job it is handed in a span of its
//! own, `job:{jobType}` carrying the job's id as `job.id`: opened in the
//! trace the job states, where the job is handed to it, and ended once it has
//! settled the job. Everything it does for the job it does in that span.

use chrono::{DateTime, SecondsFormat, Utc};
use opentelemetry::context::FutureExt;
use opentelemetry::trace::{SpanKind, TraceContextExt, Tracer};
use opentelemetry::{Context, KeyValue, global};
use semiont::claims::{
    ClaimOptions, ClaimTiming, Claims, HeldJob, JOB_CLAIM_CHANNELS, JOB_COMMIT_CHANNELS, JobFailure,
};
use semiont::client::{ClientOptions, SemiontClient};
use semiont::transport::{ConnectionState, ResourceHold, Transport};
use semiont::types::{Annotation, JobProgress, ResourceId};
use semiont_conformance_drivers::{
    Arguments, Driver, Ended, Running, count, failure, identifier, locked, object, say, serve,
    text, texts,
};
use semiont_http_transport::content::HttpContentTransport;
use semiont_http_transport::transport::{HttpTransport, HttpTransportConfig, Timing};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::sync::watch;
use tokio::task::JoinSet;

struct Opened {
    transport: HttpTransport,
    client: SemiontClient,
    /// Kept so the token's sender outlives the transport that reads it.
    _token: watch::Sender<Option<String>>,
}

#[derive(Default)]
struct Worker {
    opened: Mutex<Option<Arc<Opened>>>,
    /// A worker's timing, as `open` stated it.
    timing: Mutex<ClaimTiming>,
    claims: Mutex<Option<Arc<Claims>>>,
    /// The job the worker holds, until an operation settles it, and the
    /// context in which the span it is run in is the current one.
    held: tokio::sync::Mutex<Option<(HeldJob, Context)>>,
    holds: Mutex<Vec<ResourceHold>>,
    /// The state last reported, and the tasks that report what the worker
    /// observes.
    reported: Mutex<Option<ConnectionState>>,
    reporters: Mutex<JoinSet<()>>,
}

/// A time as the protocol carries one.
fn iso(at: SystemTime) -> String {
    DateTime::<Utc>::from(at).to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// What a case states as the wire carries it, as the SDK's type for it. One
/// the type refuses is the suite's mistake.
fn typed<T: DeserializeOwned>(value: &Value, name: &str) -> Result<T, Ended> {
    serde_json::from_value(value.clone())
        .map_err(|error| Ended::Misuse(format!("{name} is not what the SDK takes: {error}")))
}

fn optional<T: DeserializeOwned>(args: &Arguments, name: &str) -> Result<Option<T>, Ended> {
    args.get(name).map(|value| typed(value, name)).transpose()
}

/// Open the span `job` is run in, in the trace the job states, and answer
/// the context in which it is the current span.
fn span_of(job: &HeldJob) -> Context {
    let trace = job.trace();
    let within = semiont_telemetry::continued(
        trace.map(|trace| trace.traceparent.as_str()),
        trace.and_then(|trace| trace.tracestate.as_deref()),
    );
    let tracer = global::tracer("semiont-conformance-driver");
    let span = tracer
        .span_builder(format!("job:{}", job.job_type().as_str()))
        .with_kind(SpanKind::Consumer)
        .with_attributes([KeyValue::new("job.id", job.job_id().to_string())])
        .start_with_context(&tracer, &within);
    within.with_span(span)
}

/// Settle a job as `settle` does, in the job's span, and end the span once
/// that is done, however it went.
async fn settled(
    span: Context,
    settle: impl Future<Output = Result<(), Ended>>,
) -> Result<Value, Ended> {
    let outcome = settle.with_context(span.clone()).await;
    span.span().end();
    outcome.map(|()| Value::Null)
}

impl Worker {
    fn opened(&self) -> Result<Arc<Opened>, Ended> {
        locked(&self.opened)
            .clone()
            .ok_or_else(|| Ended::Misuse("no transport is open".to_owned()))
    }

    fn claiming(&self) -> Result<Arc<Claims>, Ended> {
        locked(&self.claims)
            .clone()
            .ok_or_else(|| Ended::Misuse("the worker is not claiming".to_owned()))
    }

    /// The held job and its span, taken to be settled.
    async fn settling(&self) -> Result<(HeldJob, Context), Ended> {
        self.held
            .lock()
            .await
            .take()
            .ok_or_else(|| Ended::Misuse("the worker holds no job".to_owned()))
    }

    /// Report the state the transport is in, unless it is the one last reported.
    fn report(&self, state: ConnectionState) {
        let mut reported = locked(&self.reported);
        if *reported != Some(state) {
            *reported = Some(state);
            say(json!({ "state": state.as_str() }));
        }
    }

    fn open(self: &Arc<Self>, args: &Arguments) -> Result<Value, Ended> {
        if locked(&self.opened).is_some() {
            return Err(Ended::Misuse("a transport is already open".to_owned()));
        }
        let mut timing = Timing::default();
        let mut worker = ClaimTiming::default();
        let stated = match args.get("timing") {
            None => &Arguments::new(),
            Some(_) => object(args, "timing")?,
        };
        let ms = |name: &str| count(stated, name).map(Duration::from_millis);
        for name in stated.keys() {
            match name.as_str() {
                "reconnectMs" => timing.reconnect = ms(name)?,
                "lazyRemoveMs" => timing.lazy_remove = ms(name)?,
                "lingerMs" => timing.linger = ms(name)?,
                "jobClaimTimeoutMs" => worker.job_claim = ms(name)?,
                "heldJobStallMs" => worker.held_job_stall = ms(name)?,
                "heldJobStallCheckMs" => worker.held_job_stall_check = ms(name)?,
                "markCommitTimeoutMs" => worker.mark_commit = ms(name)?,
                other => {
                    return Err(Ended::Misuse(format!(
                        "this driver cannot override {other}"
                    )));
                }
            }
        }
        let commits = match args.get("commits") {
            None => false,
            Some(Value::Bool(commits)) => *commits,
            Some(_) => return Err(Ended::Misuse("commits must be a boolean".to_owned())),
        };
        // What a worker's stream names for its claims, and for its commits
        // when it will make any, and no more: this worker awaits nothing else.
        let mut channels = JOB_CLAIM_CHANNELS.map(str::to_owned).to_vec();
        if commits {
            channels.extend(JOB_COMMIT_CHANNELS.map(str::to_owned));
        }
        *locked(&self.timing) = worker;
        let (token, tokens) = watch::channel(Some(text(args, "token")?.to_owned()));
        let transport = HttpTransport::new(HttpTransportConfig {
            base_url: text(args, "baseUrl")?.to_owned(),
            token: tokens,
            refresher: None,
            channels: Some(channels),
            http: reqwest::Client::new(),
            timing,
            bookmarks: None,
        });

        let mut reporters = locked(&self.reporters);
        let mut state = transport.state();
        let driver = self.clone();
        reporters.spawn(async move {
            loop {
                let current = *state.borrow_and_update();
                driver.report(current);
                if state.changed().await.is_err() {
                    driver.report(*state.borrow());
                    return;
                }
            }
        });
        let mut failures = transport.failures();
        reporters.spawn(async move {
            while let Some(reported) = failures.next().await {
                match reported {
                    Ok(error) => say(json!({
                        "error": failure(error.code.as_str(), error.status, error.message)
                    })),
                    Err(lagged) => eprintln!("the error stream: {lagged}"),
                }
            }
        });
        drop(reporters);

        let client = SemiontClient::new(
            Arc::new(transport.clone()),
            Arc::new(HttpContentTransport::new(&transport)),
            None,
            ClientOptions::default(),
        );
        *locked(&self.opened) = Some(Arc::new(Opened {
            transport,
            client,
            _token: token,
        }));
        Ok(Value::Null)
    }

    /// Begin claiming, and report what the claims hand out.
    fn claim(self: &Arc<Self>, args: &Arguments) -> Result<Value, Ended> {
        if locked(&self.claims).is_some() {
            return Err(Ended::Misuse("the worker is already claiming".to_owned()));
        }
        let accepts = args
            .get("accepts")
            .ok_or_else(|| Ended::Misuse("accepts must be a list of filters".to_owned()))?;
        let claims = Arc::new(self.opened()?.client.job.claim(ClaimOptions {
            timing: *locked(&self.timing),
            ..ClaimOptions::new(typed(accepts, "accepts")?)
        }));
        *locked(&self.claims) = Some(claims.clone());

        let mut reporters = locked(&self.reporters);
        let mut stalled = claims.stalled();
        reporters.spawn(async move {
            while stalled.changed().await.is_ok() {
                let stall = stalled.borrow_and_update().clone();
                if let Some(stall) = stall {
                    say(json!({ "stalled": stall.job_id }));
                }
            }
        });
        let driver = self.clone();
        reporters.spawn(async move {
            while let Some(handed) = claims.next().await {
                match handed {
                    Ok(job) => {
                        let claimed = json!({
                            "jobId": job.job_id(),
                            "jobType": job.job_type(),
                            "resourceId": job.resource_id(),
                            "params": job.params(),
                            "completedUnits": job.completed_units(),
                            "unitCursors": job.unit_cursors(),
                            "retryCount": job.retry_count(),
                            "maxRetries": job.max_retries(),
                        });
                        let (mut cancelled, job_id) = (job.cancelled(), job.job_id().clone());
                        tokio::spawn(async move {
                            if cancelled.wait_for(|cancelled| *cancelled).await.is_ok() {
                                say(json!({ "signalled": job_id }));
                            }
                        });
                        let span = span_of(&job);
                        *driver.held.lock().await = Some((job, span));
                        say(json!({ "claimed": claimed }));
                    }
                    Err(refusal) => {
                        let mut refused = json!({ "detail": refusal.message });
                        if let Some(code) = refusal.code {
                            refused["code"] = json!(code.as_str());
                        }
                        say(json!({ "refused": refused }));
                    }
                }
            }
        });
        Ok(Value::Null)
    }

    async fn operation(self: &Arc<Self>, op: &str, args: Arguments) -> Result<Value, Ended> {
        match op {
            "open" => self.open(&args),
            // A worker that stops: a job it still holds is failed first.
            "close" => {
                let claims = locked(&self.claims).clone();
                if let Some(claims) = claims {
                    claims.stop().await;
                }
                self.opened()?.transport.close().await;
                Ok(Value::Null)
            }
            "subscribe-resource" => {
                let resource: ResourceId = identifier(&args, "resource")?;
                let hold = self.opened()?.transport.subscribe_to_resource(&resource);
                locked(&self.holds).push(hold);
                Ok(Value::Null)
            }
            "claim" => self.claim(&args),
            "start" => {
                let held = self.held.lock().await;
                let (job, span) = held
                    .as_ref()
                    .ok_or_else(|| Ended::Misuse("the worker holds no job".to_owned()))?;
                job.start().with_context(span.clone()).await?;
                Ok(Value::Null)
            }
            "progress" => {
                let progress = JobProgress {
                    message: optional(&args, "message")?,
                    ..JobProgress::new(
                        args.get("percentage")
                            .and_then(Value::as_f64)
                            .ok_or_else(|| {
                                Ended::Misuse("percentage must be a number".to_owned())
                            })?,
                    )
                };
                let held = self.held.lock().await;
                let (job, span) = held
                    .as_ref()
                    .ok_or_else(|| Ended::Misuse("the worker holds no job".to_owned()))?;
                job.progress(progress).with_context(span.clone()).await?;
                Ok(Value::Null)
            }
            "checkpoint" => {
                let (units, cursors) = (
                    texts(&args, "completedUnits")?,
                    optional(&args, "unitCursors")?,
                );
                let held = self.held.lock().await;
                let (job, span) = held
                    .as_ref()
                    .ok_or_else(|| Ended::Misuse("the worker holds no job".to_owned()))?;
                job.checkpoint(units, cursors)
                    .with_context(span.clone())
                    .await?;
                Ok(Value::Null)
            }
            // The held job commits for itself: it cites its own id, and
            // remembers what the commit observed for its settle. A case
            // states an annotation as the wire carries one.
            "commit" => {
                let resource: ResourceId = identifier(&args, "resourceId")?;
                let annotations: Vec<Annotation> = typed(
                    args.get("annotations").ok_or_else(|| {
                        Ended::Misuse("annotations must be a list of annotations".to_owned())
                    })?,
                    "annotations",
                )?;
                let held = self.held.lock().await;
                let (job, span) = held
                    .as_ref()
                    .ok_or_else(|| Ended::Misuse("the worker holds no job".to_owned()))?;
                job.commit(&resource, annotations)
                    .with_context(span.clone())
                    .await?;
                Ok(Value::Null)
            }
            // A completion is its verb's, so the verb is matched before the
            // result is given. A case states a result as the wire carries
            // one, and the gateway refuses one that is the other verb's.
            "complete" => {
                let result = args
                    .get("result")
                    .ok_or_else(|| Ended::Misuse("result must be an object".to_owned()))?;
                let (job, span) = self.settling().await?;
                settled(span, async {
                    match job {
                        HeldJob::Mark(job) => job.complete(typed(result, "result")?).await?,
                        HeldJob::Yield(job) => job.complete(typed(result, "result")?).await?,
                    }
                    Ok(())
                })
                .await
            }
            "fail" => {
                let failure = JobFailure {
                    failure_class: optional(&args, "failureClass")?,
                    completed_units: optional(&args, "completedUnits")?,
                    unit_cursors: optional(&args, "unitCursors")?,
                };
                let error = text(&args, "error")?.to_owned();
                let (job, span) = self.settling().await?;
                settled(span, async { Ok(job.fail(error, failure).await?) }).await
            }
            "cancel" => {
                let (units, cursors) = (
                    optional(&args, "completedUnits")?,
                    optional(&args, "unitCursors")?,
                );
                let (job, span) = self.settling().await?;
                settled(span, async { Ok(job.cancel(units, cursors).await?) }).await
            }
            "vitals" => {
                let vitals = self.claiming()?.vitals();
                Ok(json!({
                    "lastQueuedEventAt": vitals.last_queued_event_at.map(iso),
                    "lastClaimAt": vitals.last_claim_at.map(iso),
                    "lastFinishedAt": vitals.last_finished_at.map(iso),
                    "lastActivityAt": vitals.last_activity_at.map(iso),
                    "activeJob": vitals.active_job.map(|job| json!({
                        "jobId": job.job_id, "type": job.job_type, "since": iso(job.since),
                    })),
                    "jobsCompleted": vitals.jobs_completed,
                }))
            }
            // Answers after everything the worker reported before it.
            "sync" => Ok(Value::Null),
            other => Err(Ended::Misuse(format!("no operation {other}"))),
        }
    }
}

impl Driver for Worker {
    const OPERATIONS: &'static [&'static str] = &[
        "open",
        "close",
        "subscribe-resource",
        "claim",
        "start",
        "progress",
        "checkpoint",
        "commit",
        "complete",
        "fail",
        "cancel",
        "vitals",
        "sync",
    ];

    async fn run(
        self: Arc<Self>,
        _running: Arc<Running>,
        _id: u64,
        op: String,
        args: Arguments,
    ) -> Result<Value, Ended> {
        self.operation(&op, args).await
    }

    /// The suite is done with this worker, and it ends as a worker that is
    /// killed ends: it says nothing more, of a job it holds or of anything
    /// else. A held job let go of here would be failed on its way out, which
    /// only `close` may do, so it is kept and never dropped; and neither is
    /// its span, which would end, and be exported, as it was let go of.
    async fn finish(self: Arc<Self>) {
        if let Some(held) = self.held.lock().await.take() {
            std::mem::forget(held);
        }
        let opened = locked(&self.opened).clone();
        if let Some(opened) = opened {
            opened.transport.close().await;
        }
        let mut reporters = std::mem::take(&mut *locked(&self.reporters));
        reporters.abort_all();
        while reporters.join_next().await.is_some() {}
    }
}

#[tokio::main]
async fn main() {
    serve(Worker::default()).await;
}
