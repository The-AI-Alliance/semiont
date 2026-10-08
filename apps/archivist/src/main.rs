//! The Archivist: it keeps the knowledge base's record, as
//! docs/protocol/ARCHIVIST.md states it. It boots from the document its
//! `--config` names, signs in as its service account, makes its views what
//! its log says, and then answers its channels over the gateway's bus,
//! publishes every event it appends, and serves its HTTP surface.

#![forbid(unsafe_code)]

mod anchored;
mod archivist;
mod browse;
mod bus;
mod commands;
mod content;
mod surface;

use archivist::Archivist;
use semiont::bus::{Bus, reply_channels_for};
use semiont::channels::{Channel, FrameEntityTypeAdded};
use semiont::identity::{kb_did, kb_resource};
use semiont::transport::Transport;
use semiont_archivist_record::record::Record;
use semiont_archivist_record::{Object, kb};
use semiont_archivist_staging::{Bounds, staging_for};
use semiont_core::config::{self, Document};
use semiont_core::types::ArchivistConfig;
use semiont_http_service::{IssuerVerifier, KeyTimings};
use semiont_http_transport::agent::{Agent, AgentToken};
use semiont_http_transport::service_account::{Credential, ServiceToken};
use semiont_http_transport::transport::{HttpTransport, HttpTransportConfig, Timing};
use semiont_observability::{logging, telemetry};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

const DOCUMENT: Document = Document {
    service: "archivist",
    schema: "ArchivistConfig",
};

/// The entity types every knowledge base begins with.
const DEFAULT_ENTITY_TYPES: [&str; 9] = [
    "Person",
    "Organization",
    "Location",
    "Event",
    "Concept",
    "Product",
    "Technology",
    "Date",
    "Author",
];

/// When the issuer's keys are fetched to verify a caller's token.
const KEY_TIMINGS: KeyTimings = KeyTimings {
    max_age: Duration::from_secs(600),
    refetch_cooldown: Duration::from_secs(30),
    fetch_deadline: Duration::from_secs(5),
};

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
    let document: ArchivistConfig = config::read(&path, &DOCUMENT).map_err(|e| e.to_string())?;
    let (client_id, client_secret) =
        config::service_account(&DOCUMENT).map_err(|e| e.to_string())?;
    logging::initialize(document.log_level, document.log_format);
    telemetry::initialize("semiont-archivist", semiont_core::spec::VERSION)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("cannot start the runtime: {e}"))?;
    let outcome = runtime.block_on(serve(
        document,
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

async fn serve(document: ArchivistConfig, credential: Credential) -> Result<(), String> {
    telemetry::register_supervisor_restarts();
    telemetry::sample_lag();
    let http = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("cannot build the HTTP client: {e}"))?;
    let agent = AgentToken::sign_in(
        &document.gateway_url,
        Agent {
            provider: "semiont".to_owned(),
            model: "archivist".to_owned(),
        },
        ServiceToken::new(
            Credential {
                issuer: document.identity.issuer.clone(),
                ..credential
            },
            http.clone(),
        ),
        http.clone(),
    )
    .await
    .map_err(|e| format!("cannot sign in: {e}"))?;
    logging::info("Authenticated", json!({ "component": "archivist" }));

    // What the knowledge base says of itself is read from its tree.
    let root = PathBuf::from(&document.root);
    let committed = kb::committed(&root);
    let staging = staging_for(
        &root,
        committed.git_sync,
        Bounds {
            flush: Duration::from_millis(document.staging.flush_ms),
            max_wait: Duration::from_millis(document.staging.max_wait_ms),
        },
    );
    staging.ready().await.map_err(|e| e.to_string())?;
    let Some(domain) = committed.domain.clone() else {
        return Err("The knowledge base's committed .semiont/config declares no [site] domain: it is the identity this knowledge base acts under, and the audience it accepts tokens for".to_owned());
    };

    let state_dir = PathBuf::from(&document.state_home)
        .join("semiont")
        .join(&committed.name);
    let mut record = Record::new(&root, &state_dir);
    if !document.skip_rebuild {
        logging::info(
            "Rebuilding materialized views from the event log",
            json!({ "component": "archivist" }),
        );
        let rebuilt =
            tokio::task::block_in_place(|| record.rebuild()).map_err(|e| e.to_string())?;
        for (stream, why) in &rebuilt.failed {
            logging::error(
                "A resource's view was not rebuilt",
                json!({ "component": "archivist", "resourceId": stream, "error": why }),
            );
        }
        for note in &rebuilt.notes {
            logging::warn(
                "The event log holds something that is not an event",
                json!({ "component": "archivist", "what": note }),
            );
        }
        logging::info(
            "Views rebuilt",
            json!({ "component": "archivist", "views": rebuilt.views, "reaped": rebuilt.reaped.len(), "failed": rebuilt.failed.len() }),
        );
    }

    let (facts, published) = tokio::sync::mpsc::unbounded_channel::<Object>();
    let port = document.port;
    let issuer = document.identity.issuer.clone();
    let archivist = Arc::new(Archivist::new(
        document,
        root,
        committed,
        record,
        staging.clone(),
        facts,
    ));

    // The vocabulary a knowledge base begins with, added as itself.
    let recorded: Vec<Value> = archivist
        .system_events()
        .map_err(|e| e.message)?
        .iter()
        .filter(|e| e.get("type") == Some(&json!(FrameEntityTypeAdded::NAME)))
        .filter_map(|e| e["payload"].get("entityType").cloned())
        .collect();
    let mut seeded = 0;
    for entity_type in DEFAULT_ENTITY_TYPES {
        if recorded.contains(&json!(entity_type)) {
            continue;
        }
        let mut command = Object::new();
        command.insert("tag".into(), json!(entity_type));
        command.insert("_userId".into(), json!(kb_did(&domain)));
        commands::frame_add_entity_type(&archivist, &command)
            .await
            .map_err(|e| format!("cannot seed the vocabulary: {}", e.message))?;
        seeded += 1;
    }
    logging::info(
        "Entity types bootstrap completed",
        json!({ "component": "archivist", "added": seeded, "total": DEFAULT_ENTITY_TYPES.len() }),
    );

    // The stream names what this service answers, and nothing else.
    let channels: Vec<String> = bus::COMMANDS
        .iter()
        .chain(bus::READS.iter())
        .copied()
        .map(str::to_owned)
        .collect();
    let transport = HttpTransport::new(HttpTransportConfig {
        base_url: agent.gateway().to_owned(),
        token: agent.token(),
        refresher: Some(agent.clone()),
        channels: Some(channels),
        http: http.clone(),
        timing: Timing::default(),
        bookmarks: None,
    });
    let mut ordered = Vec::new();
    for channel in bus::COMMANDS {
        ordered.push((
            channel,
            transport.frames(channel).map_err(|e| e.to_string())?,
        ));
    }
    let mut unordered = Vec::new();
    for channel in bus::READS {
        unordered.push((
            channel,
            transport.frames(channel).map_err(|e| e.to_string())?,
        ));
    }
    let bus = Bus::new(Arc::new(transport));
    for (channel, frames) in ordered {
        bus::in_order(archivist.clone(), bus.clone(), channel, frames);
    }
    for (channel, frames) in unordered {
        bus::as_they_arrive(archivist.clone(), bus.clone(), channel, frames);
    }
    bus::publish_facts(archivist.clone(), bus.clone(), published);
    observe_unpublished(archivist.clone());
    logging::info(
        "Bus pumps attached",
        json!({ "component": "archivist", "channels": bus::COMMANDS.len() + bus::READS.len(), "replies": reply_channels_for(&bus::COMMANDS).len() }),
    );

    let surface = Arc::new(surface::Surface {
        archivist: archivist.clone(),
        verifier: IssuerVerifier::new(issuer, kb_resource(&domain), KEY_TIMINGS, http),
    });
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("cannot listen on port {port}: {e}"))?;
    logging::info(
        "Archivist HTTP surface ready",
        json!({ "component": "archivist", "port": port }),
    );
    logging::info("Archivist serving", json!({ "component": "archivist" }));
    axum::serve(listener, surface::router(surface))
        .with_graceful_shutdown(stop_signal())
        .await
        .map_err(|e| e.to_string())?;
    logging::info("Shutting down", json!({ "component": "archivist" }));
    staging.dispose().await;
    Ok(())
}

/// `semiont.archivist.fact_pump.depth`: events appended and not yet
/// published, when the process exports.
fn observe_unpublished(archivist: Arc<Archivist>) {
    let Some(meter) = telemetry::meter() else {
        return;
    };
    let unpublished = archivist.unpublished.clone();
    meter
        .i64_observable_gauge("semiont.archivist.fact_pump.depth")
        .with_description("Events appended and not yet published on the bus")
        .with_callback(move |observer| observer.observe(unpublished.load(Ordering::SeqCst), &[]))
        .build();
}

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
