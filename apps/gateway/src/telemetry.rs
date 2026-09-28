//! The telemetry the gateway exports over OTLP/HTTP: the spans and metrics
//! specs/src/gateway-telemetry/telemetry.json lists, and nothing else.
//!
//! It reads the environment itself (variables.json's `gateway` rows) and
//! configures the SDK from the values: an empty resource and an explicit
//! endpoint, so no standard variable changes what the table promises. With
//! neither an endpoint nor the console exporter, or with the SDK disabled,
//! nothing is exported and no trace context travels.

use crate::spec::VERSION;
use opentelemetry::metrics::{Counter, Meter, MeterProvider as _, UpDownCounter};
use opentelemetry::propagation::TextMapPropagator;
use opentelemetry::trace::{SpanKind, TraceContextExt, Tracer, TracerProvider as _};
use opentelemetry::{Context, KeyValue};
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::{BatchSpanProcessor, SdkTracer, SdkTracerProvider};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SERVICE_NAME: &str = "semiont-gateway";
const DEFAULT_METRIC_EXPORT_INTERVAL: Duration = Duration::from_millis(30_000);

struct Telemetry {
    tracer_provider: SdkTracerProvider,
    meter_provider: SdkMeterProvider,
    tracer: SdkTracer,
    meter: Meter,
    emits: Counter<u64>,
    replies_suppressed: Counter<u64>,
    resume_gaps: Counter<u64>,
    unanswerable: Counter<u64>,
    subscribers: UpDownCounter<i64>,
    abnormal_exits: Counter<u64>,
}

static TELEMETRY: OnceLock<Option<Telemetry>> = OnceLock::new();
static PROPAGATOR: OnceLock<TraceContextPropagator> = OnceLock::new();

fn telemetry() -> Option<&'static Telemetry> {
    TELEMETRY.get().and_then(Option::as_ref)
}

fn propagator() -> &'static TraceContextPropagator {
    PROPAGATOR.get_or_init(TraceContextPropagator::new)
}

/// Start exporting, as the environment says. Call once, before the runtime
/// starts: the OTLP exporter's HTTP client runs threads of its own.
pub fn initialize() -> Result<(), String> {
    let configured = configure()?;
    if TELEMETRY.set(configured).is_err() {
        panic!("telemetry is initialized once");
    }
    install_fatal_hook();
    if telemetry().is_some() {
        register_process_start();
        register_runtime_gauges();
    }
    Ok(())
}

fn configure() -> Result<Option<Telemetry>, String> {
    if std::env::var("OTEL_SDK_DISABLED").is_ok_and(|v| v == "true") {
        return Ok(None);
    }
    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .ok()
        .filter(|e| !e.is_empty());
    let console = std::env::var("OTEL_CONSOLE_EXPORTER").is_ok_and(|v| v == "true");
    if endpoint.is_none() && !console {
        return Ok(None);
    }
    let service_name = std::env::var("OTEL_SERVICE_NAME")
        .ok()
        .unwrap_or_else(|| SERVICE_NAME.to_owned());
    let resource = Resource::builder_empty()
        .with_attributes([
            KeyValue::new("service.name", service_name),
            KeyValue::new("service.version", VERSION),
        ])
        .build();

    let url = |path: &str| {
        endpoint
            .as_ref()
            .map(|e| format!("{}/{path}", e.trim_end_matches('/')))
    };
    let spans = match url("v1/traces") {
        Some(url) => BatchSpanProcessor::builder(
            opentelemetry_otlp::SpanExporter::builder()
                .with_http()
                .with_endpoint(url)
                .build()
                .map_err(|e| format!("the OTLP span exporter: {e}"))?,
        )
        .build(),
        None => BatchSpanProcessor::builder(opentelemetry_stdout::SpanExporter::default()).build(),
    };
    let tracer_provider = SdkTracerProvider::builder()
        .with_resource(resource.clone())
        .with_span_processor(spans)
        .build();

    let interval = std::env::var("OTEL_METRIC_EXPORT_INTERVAL")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_METRIC_EXPORT_INTERVAL);
    let metrics_to_console = std::env::var("OTEL_METRICS_EXPORTER")
        .ok()
        .is_some_and(|v| v == "console");
    let metrics = SdkMeterProvider::builder().with_resource(resource);
    let meter_provider = match url("v1/metrics").filter(|_| !metrics_to_console) {
        Some(url) => metrics.with_reader(
            PeriodicReader::builder(
                opentelemetry_otlp::MetricExporter::builder()
                    .with_http()
                    .with_endpoint(url)
                    .build()
                    .map_err(|e| format!("the OTLP metric exporter: {e}"))?,
            )
            .with_interval(interval)
            .build(),
        ),
        None => metrics.with_reader(
            PeriodicReader::builder(opentelemetry_stdout::MetricExporter::default())
                .with_interval(interval)
                .build(),
        ),
    }
    .build();

    let tracer = tracer_provider.tracer("semiont");
    let meter = meter_provider.meter("semiont");
    Ok(Some(Telemetry {
        emits: meter
            .u64_counter("semiont.bus.emit")
            .with_description("Emits accepted")
            .build(),
        replies_suppressed: meter
            .u64_counter("semiont.bus.reply.suppressed")
            .with_description("Correlated replies withheld from a non-owning subscriber")
            .build(),
        resume_gaps: meter
            .u64_counter("semiont.bus.resume_gap")
            .with_description("SSE resumes that degraded to a gap because replay was unavailable")
            .build(),
        unanswerable: meter
            .u64_counter("semiont.bus.unanswerable")
            .with_description(
                "Request emits that reached zero subscribers and were failed at the gateway",
            )
            .build(),
        subscribers: meter
            .i64_up_down_counter("semiont.sse.subscribers")
            .with_description("Active SSE subscribers")
            .build(),
        abnormal_exits: meter
            .u64_counter("semiont.process.abnormal_exit")
            .with_description("Process terminations that were not a clean shutdown")
            .build(),
        tracer,
        meter,
        tracer_provider,
        meter_provider,
    }))
}

/// Export what is buffered and stop, bounded: a collector that does not
/// answer cannot hold the process open.
pub fn shutdown(within: Duration) {
    let Some(t) = telemetry() else { return };
    let (tracer_provider, meter_provider) = (t.tracer_provider.clone(), t.meter_provider.clone());
    let (done, finished) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tracer_provider.shutdown();
        let _ = meter_provider.shutdown();
        let _ = done.send(());
    });
    let _ = finished.recv_timeout(within);
}

// ── Trace context ────────────────────────────────────────────────────────

/// The W3C trace context a caller sent (`traceparent`, `tracestate`), as the
/// parent of what the gateway does for it; the current context when there is
/// none, or when nothing is exported.
pub fn continued(traceparent: Option<&str>, tracestate: Option<&str>) -> Context {
    let Some(traceparent) = traceparent.filter(|_| telemetry().is_some()) else {
        return Context::current();
    };
    let mut carrier = HashMap::from([("traceparent".to_owned(), traceparent.to_owned())]);
    if let Some(state) = tracestate {
        carrier.insert("tracestate".to_owned(), state.to_owned());
    }
    propagator().extract_with_context(&Context::current(), &carrier)
}

/// The active span's W3C trace context, when a span is active.
pub fn active_trace() -> Option<(String, Option<String>)> {
    telemetry()?;
    let context = Context::current();
    if !context.span().span_context().is_valid() {
        return None;
    }
    let mut carrier: HashMap<String, String> = HashMap::new();
    propagator().inject_context(&context, &mut carrier);
    let traceparent = carrier.remove("traceparent")?;
    Some((
        traceparent,
        carrier.remove("tracestate").filter(|s| !s.is_empty()),
    ))
}

fn started(
    name: String,
    kind: SpanKind,
    attributes: Vec<KeyValue>,
    parent: &Context,
) -> Option<Context> {
    let t = telemetry()?;
    let span = t
        .tracer
        .span_builder(name)
        .with_kind(kind)
        .with_attributes(attributes)
        .start_with_context(&t.tracer, parent);
    Some(parent.with_span(span))
}

/// Run `work` in a span, a child of `parent`.
pub async fn in_span<T>(
    name: String,
    kind: SpanKind,
    attributes: Vec<KeyValue>,
    parent: Context,
    work: impl Future<Output = T>,
) -> T {
    use opentelemetry::context::FutureExt;
    match started(name, kind, attributes, &parent) {
        None => work.with_context(parent).await,
        Some(context) => {
            let out = work.with_context(context.clone()).await;
            context.span().end();
            out
        }
    }
}

/// The same, for work that does not wait.
pub fn in_span_now<T>(
    name: String,
    kind: SpanKind,
    attributes: Vec<KeyValue>,
    parent: &Context,
    work: impl FnOnce() -> T,
) -> T {
    match started(name, kind, attributes, parent) {
        None => {
            let _attached = parent.clone().attach();
            work()
        }
        Some(context) => {
            let out = {
                let _attached = context.clone().attach();
                work()
            };
            context.span().end();
            out
        }
    }
}

// ── Metrics ──────────────────────────────────────────────────────────────

pub fn record_bus_emit(channel: &str, scope: Option<&str>) {
    let Some(t) = telemetry() else { return };
    let mut attributes = vec![KeyValue::new("bus.channel", channel.to_owned())];
    if let Some(scope) = scope {
        attributes.push(KeyValue::new("bus.scope", scope.to_owned()));
    }
    t.emits.add(1, &attributes);
}

pub fn record_reply_suppressed(channel: &str) {
    if let Some(t) = telemetry() {
        t.replies_suppressed
            .add(1, &[KeyValue::new("bus.channel", channel.to_owned())]);
    }
}

pub fn record_resume_gap(reason: &str) {
    if let Some(t) = telemetry() {
        t.resume_gaps.add(
            1,
            &[KeyValue::new("bus.resume_gap.reason", reason.to_owned())],
        );
    }
}

pub fn record_unanswerable(channel: &str) {
    if let Some(t) = telemetry() {
        t.unanswerable
            .add(1, &[KeyValue::new("bus.channel", channel.to_owned())]);
    }
}

pub fn subscriber_connected() {
    if let Some(t) = telemetry() {
        t.subscribers.add(1, &[]);
    }
}

pub fn subscriber_disconnected() {
    if let Some(t) = telemetry() {
        t.subscribers.add(-1, &[]);
    }
}

/// `semiont.bus.correlation.size`: the claims this replica's ledger holds, and their cap.
pub fn register_correlation_size(occupancy: impl Fn() -> (u64, u64) + Send + Sync + 'static) {
    let Some(t) = telemetry() else { return };
    t.meter
        .u64_observable_gauge("semiont.bus.correlation.size")
        .with_description("Correlation registry occupancy: live claims")
        .with_callback(move |observer| {
            let (claims, claims_max) = occupancy();
            observer.observe(claims, &[KeyValue::new("correlation.kind", "claims")]);
            observer.observe(
                claims_max,
                &[KeyValue::new("correlation.kind", "claims_max")],
            );
        })
        .build();
}

/// `semiont.process.restarts`: the lives the supervisor recorded, less one.
/// Only under a supervisor; unreadable, the gauge reports nothing, never zero.
pub fn register_supervisor_restarts() {
    let Some(t) = telemetry() else { return };
    let (Some(events), Some(name)) = (
        std::env::var("SUPERVISE_EVENTS").ok(),
        std::env::var("SUPERVISE_NAME").ok(),
    ) else {
        return;
    };
    if events.is_empty() || name.is_empty() {
        return;
    }
    let marker = format!("starting {name}");
    t.meter
        .u64_observable_gauge("semiont.process.restarts")
        .with_description("Times the supervisor has restarted this service")
        .with_callback(move |observer| {
            if let Ok(log) = std::fs::read_to_string(&events) {
                let lives = log.lines().filter(|line| line.contains(&marker)).count() as u64;
                observer.observe(lives.saturating_sub(1), &[]);
            }
        })
        .build();
}

fn register_process_start() {
    let Some(t) = telemetry() else { return };
    let started = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    t.meter
        .u64_observable_gauge("semiont.process.start_time")
        .with_description("Unix seconds at which this process started; a change means it restarted")
        .with_unit("s")
        .with_callback(move |observer| observer.observe(started, &[]))
        .build();
}

// ── The process's own readings ───────────────────────────────────────────

/// How late the runtime woke a task that asked to sleep 10 ms: time the
/// process could not serve anything. One window per reader, each reset when read.
struct Lag {
    windows: [Mutex<Vec<f64>>; 2],
}

static LAG: Lag = Lag {
    windows: [Mutex::new(Vec::new()), Mutex::new(Vec::new())],
};
const EXPORT_WINDOW: usize = 0;
const LOG_WINDOW: usize = 1;
const LAG_RESOLUTION: Duration = Duration::from_millis(10);
const LAG_WINDOW_SAMPLES: usize = 100_000;

/// Mean, 99th percentile and maximum, in milliseconds, of a window; emptied.
fn drain(window: usize) -> Option<(f64, f64, f64)> {
    let mut samples = std::mem::take(
        &mut *LAG.windows[window]
            .lock()
            .unwrap_or_else(|p| p.into_inner()),
    );
    if samples.is_empty() {
        return None;
    }
    samples.sort_by(f64::total_cmp);
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    let p99 = samples[((samples.len() as f64 * 0.99).ceil() as usize).saturating_sub(1)];
    Some((mean, p99, samples[samples.len() - 1]))
}

/// Sample the runtime's lag for as long as it runs, and log a summary every 30 s.
pub fn sample_lag() {
    tokio::spawn(async {
        loop {
            let asked = Instant::now();
            tokio::time::sleep(LAG_RESOLUTION).await;
            let late = asked.elapsed().saturating_sub(LAG_RESOLUTION).as_secs_f64() * 1000.0;
            for window in &LAG.windows {
                let mut samples = window.lock().unwrap_or_else(|p| p.into_inner());
                if samples.len() < LAG_WINDOW_SAMPLES {
                    samples.push(late);
                }
            }
        }
    });
    tokio::spawn(async {
        let mut every = tokio::time::interval(Duration::from_secs(30));
        every.tick().await;
        loop {
            every.tick().await;
            if let Some((mean, p99, max)) = drain(LOG_WINDOW) {
                let round = |ms: f64| (ms * 10.0).round() / 10.0;
                let fields = serde_json::json!({ "component": "event-loop-monitor", "meanMs": round(mean), "p99Ms": round(p99), "maxMs": round(max) });
                if p99 > 100.0 {
                    crate::logging::warn("event-loop delay", fields);
                } else {
                    crate::logging::info("event-loop delay", fields);
                }
            }
        }
    });
}

/// `name`'s value in /proc/self/status, in bytes.
fn process_status(name: &str) -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with(name))?;
    let kb: u64 = line[name.len()..]
        .trim()
        .trim_end_matches("kB")
        .trim()
        .parse()
        .ok()?;
    Some(kb * 1024)
}

/// The memory the process may use before it is killed: its cgroup's limit.
fn memory_limit() -> Option<u64> {
    [
        "/sys/fs/cgroup/memory.max",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    ]
    .iter()
    .find_map(|path| {
        std::fs::read_to_string(path)
            .ok()?
            .trim()
            .parse::<u64>()
            .ok()
    })
    .filter(|limit| *limit < u64::MAX / 2)
}

fn register_runtime_gauges() {
    let Some(t) = telemetry() else { return };
    let runtime = t.meter_provider.meter("semiont-runtime");
    runtime
        .f64_observable_gauge("semiont.runtime.event_loop.lag")
        .with_description("How late the runtime woke a sleeping task, over the last export interval. Time the process could not serve anything.")
        .with_unit("ms")
        .with_callback(|observer| {
            if let Some((mean, p99, max)) = drain(EXPORT_WINDOW) {
                observer.observe(mean, &[KeyValue::new("lag.stat", "mean")]);
                observer.observe(p99, &[KeyValue::new("lag.stat", "p99")]);
                observer.observe(max, &[KeyValue::new("lag.stat", "max")]);
            }
        })
        .build();
    runtime
        .u64_observable_gauge("semiont.runtime.heap")
        .with_description(
            "Process memory by kind: in use, reserved for data, the cgroup's limit, and resident.",
        )
        .with_unit("By")
        .with_callback(|observer| {
            observer.observe(
                crate::alloc::in_use() as u64,
                &[KeyValue::new("heap.stat", "used")],
            );
            if let Some(total) = process_status("VmData:") {
                observer.observe(total, &[KeyValue::new("heap.stat", "total")]);
            }
            if let Some(limit) = memory_limit() {
                observer.observe(limit, &[KeyValue::new("heap.stat", "limit")]);
            }
            if let Some(rss) = process_status("VmRSS:") {
                observer.observe(rss, &[KeyValue::new("heap.stat", "rss")]);
            }
        })
        .build();
}

/// A panic is fatal, as an uncaught exception is: record it, export what can
/// be exported within two seconds, say why on stderr, and exit non-zero.
fn install_fatal_hook() {
    static DYING: AtomicBool = AtomicBool::new(false);
    std::panic::set_hook(Box::new(|info| {
        if DYING.swap(true, Ordering::SeqCst) {
            return;
        }
        let detail = info.to_string();
        if let Some(t) = telemetry() {
            t.abnormal_exits
                .add(1, &[KeyValue::new("reason", "uncaughtException")]);
            let (tracer_provider, meter_provider) = (
                Arc::new(t.tracer_provider.clone()),
                Arc::new(t.meter_provider.clone()),
            );
            let (done, flushed) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tracer_provider.force_flush();
                let _ = meter_provider.force_flush();
                let _ = done.send(());
            });
            let _ = flushed.recv_timeout(Duration::from_secs(2));
        }
        eprintln!("[fatal] uncaughtException: {detail}");
        std::process::exit(1);
    }));
}
