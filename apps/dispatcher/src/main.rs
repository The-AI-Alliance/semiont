//! The dispatcher: the knowledge base's job control plane, as
//! docs/protocol/JOBS.md states it. It boots from the document its `--config`
//! names, signs in as its service account, opens the job queue on the broker
//! within its boot deadline, and then answers the nine job channels over the
//! gateway's bus, announcing each pending job it is delivered on `job:queued`.
//! It serves `/health` and nothing else.

#![forbid(unsafe_code)]

use axum::Router;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::any;
use futures::StreamExt;
use opentelemetry::KeyValue;
use semiont::bus::{Bus, payload_of, reply_channels_for};
use semiont::channels::{BrowseEntityTypesRequested, BrowseTagSchemasRequested, Channel, Request};
use semiont::errors::relayed_failure_code;
use semiont::timing::BUS_REQUEST_TIMEOUT;
use semiont::transport::{Envelope, Transport};
use semiont::types::{BrowseEntityTypesRequest, BrowseTagSchemasRequest, BusFrame, TagSchema};
use semiont_core::config::{self, Document};
use semiont_core::types::{
    DispatcherConfig, DispatcherHealth, DispatcherHealthQueue, DispatcherHealthStatus,
};
use semiont_dispatcher_handlers::admission::{Refusal, Vocabulary};
use semiont_dispatcher_handlers::handlers::{COMMANDS, Handlers, Reply};
use semiont_dispatcher_handlers::queue::{JobQueue, Stats};
use semiont_dispatcher_jetstream::{JetStreamQueue, Settings};
use semiont_http_transport::agent::{Agent, AgentToken};
use semiont_http_transport::service_account::{Credential, ServiceToken};
use semiont_http_transport::transport::{HttpTransport, HttpTransportConfig, Timing};
use semiont_observability::{logging, telemetry};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

const DOCUMENT: Document = Document {
    service: "dispatcher",
    schema: "DispatcherConfig",
};

const RESTART_HINT: &str = "Exiting so the container restart policy can retry — it is normal for a dependency to be slow when every service restarts at once.";

fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    std::process::exit(match boot() {
        Ok(()) => 0,
        Err(refusal) => {
            eprintln!("[fatal] {refusal}");
            1
        }
    });
}

fn boot() -> Result<(), String> {
    let path =
        config::path_from_args(std::env::args().skip(1), &DOCUMENT).map_err(|e| e.to_string())?;
    let document: DispatcherConfig = config::read(&path, &DOCUMENT).map_err(|e| e.to_string())?;
    let (client_id, client_secret) =
        config::service_account(&DOCUMENT).map_err(|e| e.to_string())?;
    let secret = |field: &str, name: &Option<String>| {
        name.as_deref()
            .map(|name| config::from_environment(field, name))
            .transpose()
            .map_err(|e| e.to_string())
    };
    let settings = Settings {
        servers: document.queue.servers.clone(),
        user: secret("queue.userEnv", &document.queue.user_env)?,
        password: secret("queue.passwordEnv", &document.queue.password_env)?,
        tick: Duration::from_millis(document.timing.tick_ms),
        stale_running: Duration::from_millis(document.timing.stale_running_ms),
        ack_wait: Duration::from_millis(document.timing.ack_wait_ms),
        retention: Duration::from_millis(document.timing.retention_ms),
        retention_sweep: Duration::from_millis(document.timing.retention_sweep_ms),
        progress_write_interval: Duration::from_millis(document.timing.progress_write_interval_ms),
    };
    logging::initialize(document.log_level, document.log_format);
    telemetry::initialize("semiont-dispatcher", semiont_core::spec::VERSION)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("cannot start the runtime: {e}"))?;
    let outcome = runtime.block_on(serve(
        document,
        settings,
        Credential {
            issuer: String::new(),
            client_id,
            client_secret,
        },
    ));
    runtime.shutdown_timeout(Duration::from_secs(1));
    telemetry::shutdown(Duration::from_secs(2));
    outcome
}

async fn serve(
    document: DispatcherConfig,
    settings: Settings,
    credential: Credential,
) -> Result<(), String> {
    telemetry::register_supervisor_restarts();
    telemetry::sample_lag();
    let http = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("cannot build the HTTP client: {e}"))?;
    let service = ServiceToken::new(
        Credential {
            issuer: document.identity.issuer.clone(),
            ..credential
        },
        http.clone(),
    );
    let agent = AgentToken::sign_in(
        &document.gateway_url,
        Agent {
            provider: "semiont".to_owned(),
            model: "dispatcher".to_owned(),
        },
        service,
        http.clone(),
    )
    .await
    .map_err(|e| format!("cannot sign in: {e}"))?;
    logging::info("Authenticated", json!({ "component": "dispatcher" }));

    let (announce, mut announcements) = tokio::sync::mpsc::unbounded_channel();
    let deadline = Duration::from_millis(document.timing.boot_deadline_ms);
    let tick = settings.tick;
    let queue = tokio::time::timeout(deadline, JetStreamQueue::connect(settings, announce))
        .await
        .map_err(|_| {
            format!(
                "Job queue did not become available within {}s. {RESTART_HINT}",
                deadline.as_millis() as f64 / 1000.0
            )
        })?
        .map_err(|e| e.to_string())?;
    let queue = Arc::new(queue);
    observe_queue_size(queue.clone(), tick);

    // The stream names what this service answers and the replies it awaits,
    // and nothing else: it is not sent every other client's replies.
    let channels: Vec<String> = COMMANDS
        .iter()
        .copied()
        .chain(reply_channels_for(&[
            BrowseEntityTypesRequested::NAME,
            BrowseTagSchemasRequested::NAME,
        ]))
        .map(str::to_owned)
        .collect();
    let transport = HttpTransport::new(HttpTransportConfig {
        base_url: agent.gateway().to_owned(),
        token: agent.token(),
        refresher: Some(agent.clone()),
        channels: Some(channels),
        http,
        timing: Timing::default(),

        bookmarks: None,
    });
    let mut commands = Vec::new();
    for command in COMMANDS {
        commands.push(transport.frames(command).map_err(|e| e.to_string())?);
    }
    let bus = Bus::new(Arc::new(transport));
    let handlers = Arc::new(Handlers::new(
        queue.clone(),
        Arc::new(BusReads { bus: bus.clone() }),
    ));

    let announcer = bus.clone();
    tokio::spawn(async move {
        while let Some(event) = announcements.recv().await {
            let sent = match payload_of(&event) {
                Ok(payload) => {
                    announcer
                        .emit_on("job:queued", payload, Envelope::default())
                        .await
                }
                Err(error) => Err(error),
            };
            if let Err(error) = sent {
                logging::warn(
                    "job:queued not sent",
                    json!({ "component": "dispatcher", "jobId": event.job_id, "error": error.to_string() }),
                );
            }
        }
    });

    let mut frames = futures::stream::select_all(commands);
    let answerer = bus.clone();
    tokio::spawn(async move {
        while let Some(delivered) = frames.next().await {
            let frame = match delivered {
                Ok(frame) => frame,
                Err(lagged) => {
                    logging::error(
                        "Frames missed",
                        json!({ "component": "dispatcher", "missed": lagged.0 }),
                    );
                    continue;
                }
            };
            let handlers = handlers.clone();
            let bus = answerer.clone();
            // In the trace the frame arrived in, so the replies are too.
            tokio::spawn(async move {
                let trace = frame.trace.clone();
                semiont_telemetry::continuing(trace.as_ref(), async {
                    let command = BusFrame {
                        channel: frame.channel,
                        correlation_id: frame.correlation_id,
                        payload: frame.payload,
                        scope: frame.scope,
                    };
                    for reply in handlers.handle(command).await {
                        send(&bus, reply).await;
                    }
                })
                .await
            });
        }
    });
    logging::info("Dispatcher serving", json!({ "channels": COMMANDS.len() }));

    let health = Router::new()
        .route("/health", any(answer_health))
        .fallback(|| async { StatusCode::NOT_FOUND });
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", document.port))
        .await
        .map_err(|e| format!("cannot listen on port {}: {e}", document.port))?;
    logging::info(
        "Dispatcher HTTP surface ready",
        json!({ "port": document.port, "paths": ["/health"] }),
    );
    axum::serve(listener, health)
        .with_graceful_shutdown(stop_signal())
        .await
        .map_err(|e| e.to_string())?;
    logging::info("Shutting down", json!({ "component": "dispatcher" }));
    Ok(())
}

async fn send(bus: &Bus, reply: Reply) {
    let envelope = Envelope {
        correlation_id: reply.correlation_id.clone(),
        scope: None,
    };
    let sent = match payload_of(&reply.payload) {
        Ok(payload) => bus.emit_on(reply.channel, payload, envelope).await,
        Err(error) => Err(error),
    };
    if let Err(error) = sent {
        logging::error(
            "A reply was not sent",
            json!({
                "component": "dispatcher",
                "channel": reply.channel,
                "correlationId": reply.correlation_id,
                "error": error.to_string(),
            }),
        );
    }
}

/// The vocabulary, read from the Archivist over the bus. A failure it answers
/// is the refusal, message and code; a failure only this side knows states no code.
struct BusReads {
    bus: Bus,
}

impl BusReads {
    /// One read of the vocabulary. A failure the Archivist answers is the
    /// refusal, with its code; one only this side knows states none.
    async fn read<R: Request>(
        &self,
        request: &R::Payload,
    ) -> Result<<R::Result as Channel>::Payload, Refusal> {
        self.bus
            .request::<R>(request, BUS_REQUEST_TIMEOUT)
            .await
            .map_err(|error| Refusal {
                message: error.to_string(),
                code: relayed_failure_code(&error),
            })
    }
}

impl Vocabulary for BusReads {
    async fn entity_types(&self) -> Result<Vec<String>, Refusal> {
        let result = self
            .read::<BrowseEntityTypesRequested>(&BrowseEntityTypesRequest {})
            .await?;
        Ok(result.response.entity_types)
    }

    async fn tag_schemas(&self) -> Result<Vec<TagSchema>, Refusal> {
        let result = self
            .read::<BrowseTagSchemasRequested>(&BrowseTagSchemasRequest {})
            .await?;
        Ok(result.response.tag_schemas)
    }
}

/// `semiont.job.queue.size`, one observation per status, when the process
/// exports. The export reads the last count, taken every tick.
fn observe_queue_size(queue: Arc<JetStreamQueue>, every: Duration) {
    let Some(meter) = telemetry::meter() else {
        return;
    };
    let latest: Arc<Mutex<Option<Stats>>> = Arc::new(Mutex::new(None));
    let observed = latest.clone();
    meter
        .u64_observable_gauge("semiont.job.queue.size")
        .with_description("Job queue size by status")
        .with_callback(move |observer| {
            let Some(stats) = *observed.lock().unwrap_or_else(|p| p.into_inner()) else {
                return;
            };
            for (status, count) in [
                ("pending", stats.pending),
                ("running", stats.running),
                ("complete", stats.complete),
                ("failed", stats.failed),
                ("cancelled", stats.cancelled),
            ] {
                observer.observe(count, &[KeyValue::new("job.status", status)]);
            }
        })
        .build();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(every);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            match queue.stats().await {
                Ok(stats) => *latest.lock().unwrap_or_else(|p| p.into_inner()) = Some(stats),
                Err(error) => logging::warn(
                    "Job queue not counted",
                    json!({ "component": "dispatcher", "error": error.0 }),
                ),
            }
        }
    });
}

async fn answer_health() -> impl IntoResponse {
    let health = DispatcherHealth {
        status: DispatcherHealthStatus::Ok,
        queue: DispatcherHealthQueue::Jetstream,
    };
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&health).expect("the health body serializes"),
    )
}

/// SIGTERM, as a supervisor stops it, or SIGINT.
async fn stop_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let Ok(mut terminate) = signal(SignalKind::terminate()) else {
        let _ = tokio::signal::ctrl_c().await;
        return;
    };
    tokio::select! {
        _ = terminate.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}
