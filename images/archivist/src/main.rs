//! The Archivist: it keeps the knowledge base's record, as
//! protocol/contract/ARCHIVIST.md states it. It boots from the document its
//! `--config` names, signs in as its service account, refuses a gateway that
//! serves another knowledge base than its tree, makes its views what its log
//! says, and then answers its channels over the gateway's bus,
//! publishes every event it appends, and serves its HTTP surface.

#![forbid(unsafe_code)]

mod anchored;
mod archivist;
mod browse;
mod bus;
mod commands;
mod content;
mod naming;
mod surface;

use archivist::Archivist;
use semiont::bus::{Bus, reply_channels_for};
use semiont::channels::{Channel, FrameEntityTypeAdded};
use semiont::identity::{kb_did, kb_resource};
use semiont::transport::{GatewayOperations, Transport};
use semiont_archivist_record::record::Record;
use semiont_archivist_record::{Object, kb};
use semiont_archivist_staging::{Bounds, staging_for};
use semiont_core::config::{self, Document};
use semiont_core::types::ArchivistConfig;
use semiont_http_service::{IssuerVerifier, KeyTimings};
use semiont_http_transport::agent::AgentToken;
use semiont_http_transport::service_account::{Credential, SecretCredential, ServiceToken};
use semiont_http_transport::transport::{HttpTransport, HttpTransportConfig, Timing};
use semiont_observability::{logging, telemetry};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::watch;

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
    // What the knowledge base says of itself is read from its tree.
    let root = PathBuf::from(&document.root);
    let committed = kb::committed(&root)?;
    let Some(domain) = committed.domain.clone() else {
        return Err("The knowledge base commits no .semiont/config.yaml, so declares no site.domain: it is the identity this knowledge base acts under, and the audience it accepts tokens for".to_owned());
    };
    telemetry::initialize(
        "semiont-archivist",
        semiont_core::spec::VERSION,
        Some(&kb_did(&domain)),
    )?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("cannot start the runtime: {e}"))?;
    let credential = SecretCredential {
        issuer: document.identity.issuer.clone(),
        client_id,
        client_secret,
    };
    let outcome = runtime.block_on(serve(document, credential, root, committed, domain));
    runtime.shutdown_timeout(Duration::from_secs(1));
    telemetry::shutdown(Duration::from_secs(2));
    outcome
}

async fn serve(
    document: ArchivistConfig,
    credential: SecretCredential,
    root: PathBuf,
    committed: kb::Committed,
    domain: String,
) -> Result<(), String> {
    telemetry::register_supervisor_restarts();
    telemetry::sample_lag();
    let http = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("cannot build the HTTP client: {e}"))?;
    let agent = AgentToken::sign_in(
        &document.gateway_url,
        ServiceToken::new(Credential::Secret(credential), http.clone()),
        http.clone(),
    )
    .await
    .map_err(|e| format!("cannot sign in: {e}"))?;
    logging::info("Authenticated", json!({ "component": "archivist" }));
    // Nothing of the tree is touched before the gateway says it serves the knowledge base the tree is.
    confirm_gateway(agent.gateway(), &http, &root, &domain).await?;

    let staging = staging_for(
        &root,
        committed.git_sync,
        Bounds {
            flush: Duration::from_millis(document.staging.flush_ms),
            max_wait: Duration::from_millis(document.staging.max_wait_ms),
        },
    );
    staging.ready().await.map_err(|e| e.to_string())?;

    // The state volume is this knowledge base's alone: an Archivist serves one.
    let mut record = Record::new(&root, Path::new(&document.state_home));
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
    let largest_bus_message = bus::largest_message(&semiont_core::spec::spec().document)?;
    let archivist = Arc::new(Archivist::new(
        document,
        root,
        committed,
        record,
        staging.clone(),
        facts,
        largest_bus_message,
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
        limits: surface::Limits::of(&semiont_core::spec::spec().archivist)?,
    });
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("cannot listen on port {port}: {e}"))?;
    logging::info(
        "Archivist HTTP surface ready",
        json!({ "component": "archivist", "port": port }),
    );
    logging::info("Archivist serving", json!({ "component": "archivist" }));
    let stopping = archivist.clone();
    axum::serve(listener, surface::router(surface))
        .with_graceful_shutdown(async move {
            stop_signal().await;
            stopping.smelt.stop_waiting();
        })
        .await
        .map_err(|e| e.to_string())?;
    logging::info("Shutting down", json!({ "component": "archivist" }));
    staging.dispose().await;
    Ok(())
}

/// The knowledge base the gateway at `gateway` serves: the `resource` of its
/// protected-resource metadata, the audience every token it admits carries.
async fn served_at(gateway: &str, http: &reqwest::Client) -> Result<String, String> {
    // Its resource metadata is public: asked with no token, so the transport opens no stream.
    let asking = HttpTransport::new(HttpTransportConfig {
        base_url: gateway.to_owned(),
        token: watch::channel(None).1,
        refresher: None,
        channels: Some(Vec::new()),
        http: http.clone(),
        timing: Timing::default(),
        bookmarks: None,
    });
    let metadata = asking.get_protected_resource_metadata().await;
    asking.close().await;
    metadata.map(|metadata| metadata.resource).map_err(|e| {
        format!(
            "The gateway at {gateway} did not say which knowledge base it serves (/.well-known/oauth-protected-resource): {e}"
        )
    })
}

/// Refuses a gateway that serves another knowledge base than the tree at
/// `root`, whose domain is `domain`: one whose resource is not the tree's, or
/// that does not say which it serves.
async fn confirm_gateway(
    gateway: &str,
    http: &reqwest::Client,
    root: &Path,
    domain: &str,
) -> Result<(), String> {
    let served = served_at(gateway, http).await?;
    let tree = kb_resource(domain);
    if served != tree {
        return Err(format!(
            "The gateway at {gateway} serves {served}, and the tree at {} is {tree} ({})",
            root.display(),
            kb_did(domain)
        ));
    }
    logging::info(
        "Gateway confirmed",
        json!({ "component": "archivist", "resource": served }),
    );
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

#[cfg(test)]
mod tests {
    use super::confirm_gateway;
    use axum::Router;
    use axum::http::header;
    use axum::routing::get;
    use semiont::types::{
        ProtectedResourceMetadata, ProtectedResourceMetadataBearerMethodsSupportedItem,
    };
    use std::path::Path;

    /// A gateway on a port of its own, answering what `app` routes; its origin.
    async fn gateway(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        origin
    }

    /// A gateway whose protected-resource metadata names `resource`.
    async fn gateway_serving(resource: &'static str) -> String {
        gateway(Router::new().route(
            "/.well-known/oauth-protected-resource",
            get(move || async move {
                let metadata = ProtectedResourceMetadata {
                    resource: resource.to_owned(),
                    authorization_servers: vec!["http://127.0.0.1:8080/realms/kb".to_owned()],
                    bearer_methods_supported: vec![
                        ProtectedResourceMetadataBearerMethodsSupportedItem::Header,
                    ],
                    resource_name: None,
                };
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    serde_json::to_string(&metadata).unwrap(),
                )
            }),
        ))
        .await
    }

    fn http() -> reqwest::Client {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::new()
    }

    #[tokio::test]
    async fn a_gateway_that_serves_the_trees_knowledge_base_is_its_gateway() {
        let origin = gateway_serving("https://example.github.io/my-kb").await;
        let confirmed = confirm_gateway(
            &origin,
            &http(),
            Path::new("/kb"),
            "example.github.io:my-kb",
        )
        .await;
        assert_eq!(confirmed, Ok(()));
    }

    #[tokio::test]
    async fn a_gateway_that_serves_another_knowledge_base_is_refused_naming_both() {
        let origin = gateway_serving("https://example.github.io/other-kb").await;
        let refused = confirm_gateway(
            &origin,
            &http(),
            Path::new("/kb"),
            "example.github.io:my-kb",
        )
        .await;
        assert_eq!(
            refused,
            Err(format!(
                "The gateway at {origin} serves https://example.github.io/other-kb, and the tree at /kb is https://example.github.io/my-kb (did:web:example.github.io:my-kb)"
            ))
        );
    }

    #[tokio::test]
    async fn a_gateway_that_does_not_say_which_knowledge_base_it_serves_is_refused_saying_so() {
        let origin = gateway(Router::new()).await;
        let refused = confirm_gateway(
            &origin,
            &http(),
            Path::new("/kb"),
            "example.github.io:my-kb",
        )
        .await;
        let why = refused.unwrap_err();
        assert!(
            why.starts_with(&format!(
                "The gateway at {origin} did not say which knowledge base it serves (/.well-known/oauth-protected-resource): "
            )),
            "{why}"
        );
    }
}
