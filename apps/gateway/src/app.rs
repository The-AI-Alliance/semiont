//! Boot: everything the gateway needs is checked before it listens, and a
//! gateway that lacks any of it exits non-zero without serving, saying what
//! is missing and never a secret it was given.

use crate::archivist::Archivist;
use crate::composition::{Composition, compose};
use crate::config::{SignalConfig, read_gateway_config};
use crate::issuer::IssuerVerifier;
use crate::rates::EmitRates;
use crate::signal::SignalPlane;
use crate::signal::in_process::InProcessPlane;
use crate::signal::nats::NatsPlane;
use crate::tokens::{KeyRing, require_jwt_secret};
use crate::{archivist, metrics, routes};
use semiont::identity;
use semiont::service_account::Credential;
use semiont_core::config::{self, GatewayConfig};
use semiont_core::{bus_log, logging, telemetry};
use serde_json::json;
use socket2::{Domain, Protocol, Socket, Type};
use std::future::Future;
use std::net::{Ipv6Addr, SocketAddr};
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;

/// What the routes share.
pub struct App {
    pub config: GatewayConfig,
    pub keys: KeyRing,
    pub issuer: IssuerVerifier,
    pub archivist: Archivist,
    pub bus: Composition,
    pub emit_rates: EmitRates,
    /// The bytes queued for every stream this process holds: what `capacity.queuedBytes` bounds.
    pub queued_bytes: AtomicUsize,
}

/// Bound on a round trip to the broker, at boot and at shutdown: one
/// ping to a reachable broker takes milliseconds; a dead one never answers.
const BROKER_DEADLINE: Duration = Duration::from_secs(10);

/// This process's own account at the issuer, which it reaches the Archivist with.
fn require_service_account() -> Result<(String, String), String> {
    let id = std::env::var("SEMIONT_OIDC_CLIENT_ID")
        .ok()
        .filter(|v| !v.is_empty());
    let secret = std::env::var("SEMIONT_OIDC_CLIENT_SECRET")
        .ok()
        .filter(|v| !v.is_empty());
    if let (Some(id), Some(secret)) = (&id, &secret) {
        return Ok((id.clone(), secret.clone()));
    }
    let missing: Vec<&str> = [
        ("SEMIONT_OIDC_CLIENT_ID", id.is_none()),
        ("SEMIONT_OIDC_CLIENT_SECRET", secret.is_none()),
    ]
    .into_iter()
    .filter_map(|(name, absent)| absent.then_some(name))
    .collect();
    Err(format!(
        "{} not set — this gateway has no service account, so it cannot authenticate to the Archivist and every read of the record would fail.\n\
         The launcher passes both for each service it starts; a gateway started another way needs the client its realm registers for it (SEMIONT_OIDC_CLIENT_ID=semiont-gateway).",
        missing.join(" and ")
    ))
}

async fn within<T>(
    what: &str,
    refusal: &str,
    work: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    match tokio::time::timeout(BROKER_DEADLINE, work).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(format!("{what}: {error}\n{refusal}")),
        Err(_) => Err(format!(
            "{what} did not complete within {} s. {refusal}",
            BROKER_DEADLINE.as_secs()
        )),
    }
}

/// The process: exit code 0 after a clean shutdown, 1 when it refused to start.
pub fn main() -> i32 {
    let _ = rustls::crypto::ring::default_provider().install_default();
    match boot() {
        Ok(code) => code,
        Err(refusal) => {
            eprintln!("{refusal}");
            1
        }
    }
}

fn boot() -> Result<i32, String> {
    let (config, signal) =
        read_gateway_config(std::env::args().skip(1)).map_err(|e| e.to_string())?;
    let keys = KeyRing::new(require_jwt_secret()?, config.kb.domain.clone());
    let (client_id, client_secret) = require_service_account()?;
    logging::initialize(config.log_level, config.log_format);
    bus_log::configure();
    telemetry::initialize("semiont-gateway")?;
    // One worker per CPU the process may use (its cgroup quota and affinity),
    // stated here so tokio never reads TOKIO_WORKER_THREADS: the container's
    // CPU limit is the one thing that sizes the gateway.
    let workers = std::thread::available_parallelism().map_or(1, NonZeroUsize::get);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .enable_all()
        .build()
        .map_err(|e| format!("cannot start the runtime: {e}"))?;
    let outcome = runtime.block_on(run(
        config,
        signal,
        keys,
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

async fn run(
    config: GatewayConfig,
    signal: SignalConfig,
    keys: KeyRing,
    credential: Credential,
) -> Result<i32, String> {
    let http = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("cannot build the HTTP client: {e}"))?;
    let undeclared = archivist::undeclared_calls();
    if !undeclared.is_empty() {
        return Err(format!(
            "The gateway calls Archivist operations its spec does not declare: {}",
            undeclared.join(", ")
        ));
    }
    let issuer = IssuerVerifier::new(
        config.identity.issuer.clone(),
        identity::kb_resource(&config.kb.domain),
        http.clone(),
    );
    let archivist = Archivist::new(
        &config.archivist.host,
        config.archivist.port,
        Credential {
            issuer: config.identity.issuer.clone(),
            ..credential
        },
        http,
    );

    let (plane, driver): (Arc<dyn SignalPlane>, &str) = match &signal {
        SignalConfig::InProcess => (Arc::new(InProcessPlane::new()), "in-process"),
        SignalConfig::Nats {
            servers,
            user_env,
            password_env,
        } => {
            let user = user_env
                .as_deref()
                .map(|name| config::from_environment("/signal/userEnv", name))
                .transpose()
                .map_err(|e| e.to_string())?;
            let password = password_env
                .as_deref()
                .map(|name| config::from_environment("/signal/passwordEnv", name))
                .transpose()
                .map_err(|e| e.to_string())?;
            (
                Arc::new(NatsPlane::connect(servers, user, password).await?),
                "nats",
            )
        }
    };
    logging::info("Signal Plane driver selected", json!({ "driver": driver }));
    let bus = within(
        "Ledger claims table",
        "The broker did not open the claims table; it must run with JetStream enabled.",
        compose(plane.clone()),
    )
    .await?;
    within(
        "Signal Plane readiness flush",
        "The broker is unreachable; the gateway will not serve until it answers.",
        plane.flush(),
    )
    .await?;
    logging::info("Signal Plane ready", json!({ "driver": driver }));

    let ledger = bus.ledger.clone();
    metrics::register_correlation_size(move || ledger.occupancy());
    telemetry::register_supervisor_restarts();
    telemetry::sample_lag();

    let mismatches = routes::mismatches();
    if !mismatches.is_empty() {
        let lines: Vec<String> = mismatches.iter().map(|m| format!("  - {m}")).collect();
        return Err(format!(
            "The gateway's routes are not its spec's operations:\n{}\nThe spec is the route table: declare a route in specs/src before serving it, and serve every operation it declares.",
            lines.join("\n")
        ));
    }

    let port = config.port;
    let app = Arc::new(App {
        config,
        keys,
        issuer,
        archivist,
        bus,
        emit_rates: EmitRates::default(),
        queued_bytes: AtomicUsize::new(0),
    });
    let listener = listen(port).map_err(|e| format!("cannot listen on port {port}: {e}"))?;
    logging::info(
        "Semiont Gateway ready",
        json!({
            "url": format!("http://localhost:{port}/api"),
            "capacity": {
                "queuedBytes": app.config.capacity.queued_bytes,
                "connections": app.config.capacity.connections,
            },
        }),
    );
    logging::info(
        "Auth posture: bearer-only, open CORS",
        json!({ "cors": "any origin (*)", "credentials": "disabled", "auth": "Authorization: Bearer; media tokens via ?token= for /api/resources/:id" }),
    );

    let (tx, rx) = tokio::sync::oneshot::channel::<&'static str>();
    tokio::spawn(async move {
        let _ = tx.send(stop_signal().await);
    });
    let mut received = "";
    crate::http::serve(
        listener,
        routes::router(app.clone()),
        app.config.capacity.connections as usize,
        async {
            received = rx.await.unwrap_or("SIGTERM");
        },
    )
    .await;
    logging::info("Shutting down", json!({ "signal": received }));
    // Drain what this connection already wrote before it goes with the
    // process: best effort, bounded, and said when it does not finish.
    if tokio::time::timeout(BROKER_DEADLINE, app.bus.plane.flush())
        .await
        .is_err()
    {
        logging::warn(
            "Signal Plane drain timed out; in-flight frames may be lost",
            json!({}),
        );
    }
    logging::info("Shutdown complete", json!({}));
    Ok(0)
}

/// Every address the host has, IPv4 and IPv6 alike: one IPv6 socket that also
/// takes IPv4 as mapped addresses, whatever the host's own `IPV6_V6ONLY` default.
fn listen(port: u16) -> std::io::Result<tokio::net::TcpListener> {
    let socket = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_only_v6(false)?;
    socket.set_reuse_address(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&SocketAddr::from((Ipv6Addr::UNSPECIFIED, port)).into())?;
    socket.listen(1024)?;
    tokio::net::TcpListener::from_std(socket.into())
}

async fn stop_signal() -> &'static str {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut term), Ok(mut interrupt)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = term.recv() => "SIGTERM",
        _ = interrupt.recv() => "SIGINT",
    }
}
