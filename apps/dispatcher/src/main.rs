//! The dispatcher, in Rust — so far a skeleton. It boots as the dispatcher
//! does: its document from `--config`, its service account, its agent session
//! with the gateway, a stream of every channel the dispatcher answers, and
//! `/health`. It answers nothing on the bus: the dispatcher conformance suite
//! run against it fails every case for want of a reply, which proves the
//! client beneath it signs in, subscribes and is delivered to.

#![forbid(unsafe_code)]

use axum::Router;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::any;
use semiont::bus::{Bus, operation};
use semiont::service_account::{Credential, ServiceToken};
use semiont::session::{Agent, AgentSession};
use semiont_core::config::{self, Document};
use semiont_core::types::{
    DispatcherConfig, DispatcherHealth, DispatcherHealthQueue, DispatcherHealthStatus,
};
use semiont_core::{logging, telemetry};
use serde_json::json;
use std::sync::Arc;

#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

const DOCUMENT: Document = Document {
    service: "dispatcher",
    schema: "DispatcherConfig",
};

/// The channels the dispatcher answers (JOBS.md § Channels).
const COMMANDS: [&str; 9] = [
    "job:create",
    "job:claim",
    "job:complete",
    "job:fail",
    "job:report-progress",
    "job:checkpoint",
    "job:cancel-requested",
    "job:cancel",
    "job:status-requested",
];

/// The reads `job:create` makes over the bus, whose replies it subscribes to.
const READS: [&str; 2] = [
    "browse:entity-types-requested",
    "browse:tag-schemas-requested",
];

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
    logging::initialize(document.log_level, document.log_format);
    telemetry::initialize("semiont-dispatcher")?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("cannot start the runtime: {e}"))?;
    runtime.block_on(serve(
        document,
        Credential {
            issuer: String::new(),
            client_id,
            client_secret,
        },
    ))
}

async fn serve(document: DispatcherConfig, credential: Credential) -> Result<(), String> {
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
    let session = Arc::new(AgentSession::new(
        &document.gateway_url,
        Agent {
            provider: "semiont".to_owned(),
            model: "dispatcher".to_owned(),
        },
        service,
        http.clone(),
    ));
    session
        .token()
        .await
        .map_err(|e| format!("cannot sign in: {e}"))?;
    logging::info("Authenticated", json!({ "component": "dispatcher" }));

    let mut channels: Vec<String> = COMMANDS.iter().map(|c| (*c).to_owned()).collect();
    for read in READS {
        let op =
            operation(read).ok_or_else(|| format!("the registry declares no operation {read}"))?;
        channels.extend([op.result.to_owned(), op.failure.to_owned()]);
    }
    let bus = Bus::open(session, http, channels);
    let mut frames = bus.frames();
    tokio::spawn(async move {
        while let Ok(frame) = frames.recv().await {
            logging::debug(
                "A frame the skeleton does not answer",
                json!({ "channel": frame.channel, "correlationId": frame.correlation_id }),
            );
        }
    });

    let health = Router::new()
        .route("/health", any(answer_health))
        .fallback(|| async { StatusCode::NOT_FOUND });
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", document.port))
        .await
        .map_err(|e| format!("cannot listen on port {}: {e}", document.port))?;
    logging::info("Dispatcher serving", json!({ "port": document.port }));
    axum::serve(listener, health)
        .with_graceful_shutdown(stop_signal())
        .await
        .map_err(|e| e.to_string())?;
    drop(bus);
    Ok(())
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
