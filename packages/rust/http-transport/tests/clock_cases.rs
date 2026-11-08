//! The time a client keeps, against `protocol/specs/src/client/clock-cases.json`.
//!
//! Each case builds its subject at this SDK's timings, which are the table's,
//! on a runtime of its own whose clock starts paused, and with the lowest draw
//! the jitter's random source can give.
//!
//! A subject in this process alone lets the paused clock run to each instant
//! a timer falls due, in turn, as `semiont`'s `state_cases.rs` does: a `pass`
//! sleeps, and what falls due on the way runs where it falls due.
//!
//! A subject over the network meets a gateway in this process over loopback
//! TCP: reqwest has no transport but a socket. A paused runtime with nothing
//! to run moves its clock to the next timer, and a socket that has an answer
//! on its way leaves it nothing to run, so the clock would pass a deadline
//! before the answer that beats it arrived. So such a case holds the clock
//! still with a blocking task that lasts the case, which a paused runtime
//! does not move its clock past, and moves it only by `tokio::time::advance`.
//! A settle there is a real wait: until a few moments pass in which the
//! gateway hears nothing more. A pass moves the clock to its end at once, so
//! what falls due inside it runs at its end: no count of the table's network
//! subjects is of a timer that falls due inside a pass.
//!
//! What the table may say is held by
//! `.github/scripts/checks/specs/check-case-tables.mjs`.

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use futures::FutureExt;
use futures::future::LocalBoxFuture;
use futures::stream::Stream;
use rand_core::{Rng, TryRng};
use semiont::bus::{Bus, operation};
use semiont::cache::{Cache, CachePersister};
use semiont::claims::ClaimOptions;
use semiont::discovery::{DiscoveryRead, DiscoveryState, DiscoveryTransport, subscribe_discovery};
use semiont::errors::{BusRequestErrorCode, SemiontError};
use semiont::session::{SemiontSession, SemiontSessionConfig, StoredSession, store_session};
use semiont::storage::InMemorySessionStorage;
use semiont::testing::{FaultyTransport, TestClientOptions, as_id, create_test_client};
use semiont::transport::{
    BoxFuture, ConnectionState, Envelope, Frame, GatewayOperations, ResourceHold, Transport,
};
use semiont::types::{
    DiscoveredKB, HighlightingJobParams, HttpEndpoint, HttpEndpointProtocol, JobFilter,
    JobProgress, KbTarget, UserResponse,
};
use semiont_http_transport::oauth::sign_in_with_device_grant;
use semiont_http_transport::transport::{HttpTransport, HttpTransportConfig, Timing};
use serde_json::{Map, Value, json};
use std::any::Any;
use std::cell::Cell;
use std::collections::{BTreeSet, HashMap};
use std::convert::Infallible;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::{Pin, pin};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

static TABLE: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../protocol/specs/src/client/clock-cases.json"
    ))
    .expect("the clock table is JSON")
});

static TIMING: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../protocol/specs/src/client/timing.json"
    ))
    .expect("the timing table is JSON")
});

/// How many turns of the runtime a settle lets pass: enough for what any case
/// sets going in this process to run as far as it can without the clock
/// moving.
const SETTLE_TURNS: usize = 200;

/// How many turns a piece of work that is to end without the clock moving is
/// given to end in: room for settles of its own.
const AT_ONCE_TURNS: usize = 10 * SETTLE_TURNS;

/// How long, in real time, one quiet moment of a settle over the network is.
const QUIET: Duration = Duration::from_millis(1);

/// How many quiet moments in a row end a settle over the network: the client
/// reads the last answer the gateway wrote in the first of them.
const QUIET_MOMENTS: usize = 3;

fn cases() -> &'static [Value] {
    TABLE["cases"].as_array().expect("the table lists cases")
}

// ── Durations ───────────────────────────────────────────────────────────

/// A duration `protocol/specs/src/client/timing.json` names, in
/// milliseconds. A retry budget's member follows its budget and a `.`.
fn timing_ms(name: &str) -> f64 {
    let (budget, member) = match name.split_once('.') {
        Some((budget, member)) => (budget, Some(member)),
        None => (name, None),
    };
    let entry = TIMING["timing"]
        .as_array()
        .expect("the timing table lists its timings")
        .iter()
        .find(|entry| entry["name"] == budget)
        .unwrap_or_else(|| panic!("{name} is no timing of protocol/specs/src/client/timing.json"));
    let value = match member {
        Some(member) => &entry["value"][member],
        None => &entry["value"],
    };
    value
        .as_f64()
        .unwrap_or_else(|| panic!("{name} is no duration"))
}

/// A duration as the table states it, in milliseconds: a whole number of them.
fn duration_ms(value: &Value) -> u64 {
    if let Some(ms) = value.as_u64() {
        return ms;
    }
    let stated = value
        .as_object()
        .expect("a duration is milliseconds, or a timing");
    let times = stated
        .get("times")
        .map_or(1.0, |times| times.as_f64().expect("times is a number"));
    let plus = stated.get("plusMs").map_or(0.0, |plus| {
        plus.as_i64().expect("plusMs is whole milliseconds") as f64
    });
    let scaled = timing_ms(stated["timing"].as_str().expect("a timing's name")) * times + plus;
    assert!(
        scaled >= 0.0 && scaled.fract() == 0.0,
        "{value} is not a whole number of milliseconds"
    );
    scaled as u64
}

// ── The clock ───────────────────────────────────────────────────────────

async fn turns(count: usize) {
    for _ in 0..count {
        tokio::task::yield_now().await;
    }
}

/// `work`, which is to end with what is ready, the clock not moving. A still
/// clock never ends a wait, so a `work` that waits for time fails here.
async fn at_once<T>(work: impl Future<Output = T>) -> Result<T, String> {
    let mut work = pin!(work);
    for _ in 0..AT_ONCE_TURNS {
        if let Some(done) = work.as_mut().now_or_never() {
            return Ok(done);
        }
        tokio::task::yield_now().await;
    }
    Err("it did not end without the clock moving".to_owned())
}

/// A blocking task that lasts until this is dropped. While one is in flight a
/// paused runtime does not move its clock by itself.
struct Still {
    _release: std::sync::mpsc::Sender<()>,
}

impl Still {
    fn hold() -> Still {
        let (release, released) = std::sync::mpsc::channel::<()>();
        tokio::task::spawn_blocking(move || {
            // Ends when the sender is dropped.
            let _ = released.recv();
        });
        Still { _release: release }
    }
}

/// A gateway in this process, the server that answers for it, and the still
/// clock of the case that meets it.
struct Network {
    ledger: Arc<Ledger>,
    origin: String,
    port: u16,
    server: tokio::task::JoinHandle<()>,
    _still: Still,
}

impl Drop for Network {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Network {
    /// Hold the clock still, then serve `app` on a loopback port.
    async fn serve(ledger: Arc<Ledger>, app: impl FnOnce(String) -> Router) -> Network {
        let still = Still::hold();
        // Already installed by another case of this process: one is enough.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a port");
        let port = listener.local_addr().expect("an address").port();
        let origin = format!("http://127.0.0.1:{port}");
        let app = app(origin.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("the server serves");
        });
        Network {
            ledger,
            origin,
            port,
            server,
            _still: still,
        }
    }
}

/// Let what is ready run, and what that makes ready, without moving the
/// clock; over the network, until the gateway has heard nothing more for
/// `QUIET_MOMENTS` moments in a row.
async fn settle(network: Option<&Network>) {
    turns(SETTLE_TURNS).await;
    let Some(network) = network else {
        return;
    };
    let mut quiet = 0;
    while quiet < QUIET_MOMENTS {
        let heard = network.ledger.heard();
        tokio::task::spawn_blocking(|| std::thread::sleep(QUIET))
            .await
            .expect("a quiet moment");
        turns(SETTLE_TURNS).await;
        quiet = if network.ledger.heard() == heard {
            quiet + 1
        } else {
            0
        };
    }
}

/// Settle, move the clock `ms` ahead, and settle again.
async fn pass(network: Option<&Network>, ms: u64) {
    settle(network).await;
    let span = Duration::from_millis(ms);
    match network {
        Some(_) => tokio::time::advance(span).await,
        None => tokio::time::sleep(span).await,
    }
    settle(network).await;
}

// ── What a case drives ──────────────────────────────────────────────────

/// What a case drives: what it counts, its action when it has one, the
/// gateway it meets when it is over the network, and what it holds until the
/// case is over.
struct Subject {
    counted: Box<dyn Fn() -> usize>,
    act: Option<Box<dyn Fn() -> LocalBoxFuture<'static, ()>>>,
    network: Option<Network>,
    _held: Vec<Box<dyn Any>>,
}

/// How a subject is built, from what the case's `given` states.
type Build = fn(Map<String, Value>) -> LocalBoxFuture<'static, Subject>;

/// A span of seconds the case's `given` states, when it states one.
fn given_seconds(given: &Map<String, Value>, name: &str) -> Option<u64> {
    given.get(name).map(|value| {
        value
            .as_u64()
            .unwrap_or_else(|| panic!("given.{name} is not a whole number of seconds"))
    })
}

/// How many of the values `watched` comes to hold `counts` counts, from now
/// on. Each count of a case comes after a settle, in which this reads every
/// change before it.
fn tally<T: Send + Sync + 'static>(
    mut watched: watch::Receiver<T>,
    counts: impl Fn(&T) -> bool + Send + 'static,
) -> Box<dyn Fn() -> usize> {
    let seen = Arc::new(AtomicUsize::new(0));
    let seeing = seen.clone();
    tokio::spawn(async move {
        watched.borrow_and_update();
        while watched.changed().await.is_ok() {
            if counts(&watched.borrow_and_update()) {
                seeing.fetch_add(1, Ordering::SeqCst);
            }
        }
    });
    Box::new(move || seen.load(Ordering::SeqCst))
}

// ── The gateway ─────────────────────────────────────────────────────────

const SUBSCRIBE: &str = "/bus/subscribe";
const EMIT: &str = "/bus/emit";
const HEALTH: &str = "/api/health";

/// What a gateway in this process has heard.
#[derive(Default)]
struct Ledger {
    /// How many requests of each path it has been asked.
    asked: Mutex<HashMap<String, usize>>,
    /// How many of the streams it held open their readers have closed.
    closed: AtomicUsize,
    /// Everything it has heard: each request, and each stream closed.
    heard: AtomicUsize,
    /// The requests it was asked that its subject does not have it answer.
    strays: Mutex<Vec<String>>,
}

impl Ledger {
    fn ask(&self, path: &str) {
        *self
            .asked
            .lock()
            .expect("the ledger")
            .entry(path.to_owned())
            .or_default() += 1;
        self.heard.fetch_add(1, Ordering::SeqCst);
    }

    fn asked(&self, path: &str) -> usize {
        self.asked
            .lock()
            .expect("the ledger")
            .get(path)
            .copied()
            .unwrap_or(0)
    }

    fn close(&self) {
        self.closed.fetch_add(1, Ordering::SeqCst);
        self.heard.fetch_add(1, Ordering::SeqCst);
    }

    fn heard(&self) -> usize {
        self.heard.load(Ordering::SeqCst)
    }

    fn stray(&self, request: String) -> Response {
        self.strays.lock().expect("the ledger").push(request);
        StatusCode::NOT_FOUND.into_response()
    }
}

/// How a gateway answers a subscribe: with a stream it holds open, with a
/// 503, or not at all.
#[derive(Clone, Copy)]
enum StreamAnswer {
    Holds,
    Refuses,
    Never,
}

/// A gateway in this process. It answers each request at once, as the subject
/// has it answer: a subscribe as `stream` says, a request of the paths it
/// refuses with a 503, and one of the paths it leaves unanswered never. Its
/// refusals carry a `Retry-After` of `retry_after_seconds`, when it states
/// one.
struct Gateway {
    ledger: Arc<Ledger>,
    stream: StreamAnswer,
    retry_after_seconds: Option<u64>,
    refused: &'static [&'static str],
    unanswered: &'static [&'static str],
}

impl Gateway {
    fn refusal(&self) -> Response {
        let mut refused = (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "The gateway is not ready" })),
        )
            .into_response();
        if let Some(seconds) = self.retry_after_seconds {
            refused
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(seconds));
        }
        refused
    }
}

/// The body of a stream a gateway holds open and says nothing on. Its reader
/// closing the connection drops it.
struct HeldOpen(Arc<Ledger>);

impl Stream for HeldOpen {
    type Item = Result<Bytes, Infallible>;

    fn poll_next(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Poll::Pending
    }
}

impl Drop for HeldOpen {
    fn drop(&mut self) {
        self.0.close();
    }
}

async fn gateway_answer(State(gateway): State<Arc<Gateway>>, request: Request) -> Response {
    let (method, path) = (request.method().clone(), request.uri().path().to_owned());
    gateway.ledger.ask(&path);
    // Read whole, so the server reads the connection on and sees its end.
    axum::body::to_bytes(request.into_body(), usize::MAX)
        .await
        .expect("the request's body");
    if gateway.unanswered.contains(&path.as_str()) {
        return std::future::pending().await;
    }
    if gateway.refused.contains(&path.as_str()) {
        return gateway.refusal();
    }
    if path != SUBSCRIBE {
        return gateway.ledger.stray(format!("{method} {path}"));
    }
    match gateway.stream {
        StreamAnswer::Holds => (
            [(header::CONTENT_TYPE, "text/event-stream")],
            Body::from_stream(HeldOpen(gateway.ledger.clone())),
        )
            .into_response(),
        StreamAnswer::Refuses => gateway.refusal(),
        StreamAnswer::Never => std::future::pending().await,
    }
}

/// A random source whose every draw is the lowest it can give.
struct LowestDraw;

impl TryRng for LowestDraw {
    type Error = Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Infallible> {
        Ok(0)
    }

    fn try_next_u64(&mut self) -> Result<u64, Infallible> {
        Ok(0)
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Infallible> {
        dst.fill(0);
        Ok(())
    }
}

fn lowest() -> Arc<Mutex<dyn Rng + Send>> {
    Arc::new(Mutex::new(LowestDraw))
}

/// A gateway that answers as `stream`, `retry_after_seconds`, `refused` and
/// `unanswered` say, and a transport to it, open and holding a token, so its
/// stream is set going.
async fn over_a_gateway(
    stream: StreamAnswer,
    retry_after_seconds: Option<u64>,
    refused: &'static [&'static str],
    unanswered: &'static [&'static str],
) -> (Arc<HttpTransport>, Network) {
    let ledger = Arc::new(Ledger::default());
    let gateway = Arc::new(Gateway {
        ledger: ledger.clone(),
        stream,
        retry_after_seconds,
        refused,
        unanswered,
    });
    let network = Network::serve(ledger, |_| {
        Router::new().fallback(gateway_answer).with_state(gateway)
    })
    .await;
    let transport = Arc::new(HttpTransport::new(HttpTransportConfig {
        base_url: network.origin.clone(),
        token: watch::channel(Some("a-token".to_owned())).1,
        refresher: None,
        channels: None,
        http: http(),
        timing: Timing::default(),
        bookmarks: None,
        random: Some(lowest()),
    }));
    (transport, network)
}

/// A client of the network faked in this process, and nothing else: no proxy
/// the environment names.
fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("a client")
}

fn refused_stream(given: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let (transport, network) = over_a_gateway(
            StreamAnswer::Refuses,
            given_seconds(&given, "retryAfterSeconds"),
            &[],
            &[],
        )
        .await;
        let ledger = network.ledger.clone();
        Subject {
            counted: Box::new(move || ledger.asked(SUBSCRIBE)),
            act: None,
            network: Some(network),
            _held: vec![Box::new(transport)],
        }
    }
    .boxed_local()
}

fn unanswered_stream(_: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let (transport, network) = over_a_gateway(StreamAnswer::Never, None, &[], &[]).await;
        let ledger = network.ledger.clone();
        Subject {
            counted: Box::new(move || ledger.asked(SUBSCRIBE)),
            act: None,
            network: Some(network),
            _held: vec![Box::new(transport)],
        }
    }
    .boxed_local()
}

fn degraded_stream(given: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let (transport, network) = over_a_gateway(
            StreamAnswer::Refuses,
            given_seconds(&given, "retryAfterSeconds"),
            &[],
            &[],
        )
        .await;
        Subject {
            counted: tally(transport.state(), |state| {
                *state == ConnectionState::Degraded
            }),
            act: None,
            network: Some(network),
            _held: vec![Box::new(transport)],
        }
    }
    .boxed_local()
}

/// The action that takes the resource's scope, and keeps it until the case
/// is over.
fn taking(transport: &Arc<HttpTransport>) -> Box<dyn Fn() -> LocalBoxFuture<'static, ()>> {
    let (transport, holds) = (transport.clone(), Arc::new(Mutex::new(Vec::new())));
    Box::new(move || {
        let hold = transport.subscribe_to_resource(&as_id("res-1"));
        holds.lock().expect("the holds").push(hold);
        async {}.boxed_local()
    })
}

fn scope_taken(_: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let (transport, network) = over_a_gateway(StreamAnswer::Holds, None, &[], &[]).await;
        let ledger = network.ledger.clone();
        Subject {
            counted: Box::new(move || ledger.asked(SUBSCRIBE)),
            act: Some(taking(&transport)),
            network: Some(network),
            _held: vec![Box::new(transport)],
        }
    }
    .boxed_local()
}

fn scope_let_go(_: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let (transport, network) = over_a_gateway(StreamAnswer::Holds, None, &[], &[]).await;
        settle(Some(&network)).await;
        assert_eq!(
            *transport.state().borrow(),
            ConnectionState::Open,
            "the stream opened"
        );
        let hold: Mutex<Option<ResourceHold>> =
            Mutex::new(Some(transport.subscribe_to_resource(&as_id("res-1"))));
        let ledger = network.ledger.clone();
        Subject {
            counted: Box::new(move || ledger.asked(SUBSCRIBE)),
            act: Some(Box::new(move || {
                drop(hold.lock().expect("the hold").take());
                async {}.boxed_local()
            })),
            network: Some(network),
            _held: vec![Box::new(transport)],
        }
    }
    .boxed_local()
}

fn handoff_linger(_: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let (transport, network) = over_a_gateway(StreamAnswer::Holds, None, &[], &[]).await;
        let ledger = network.ledger.clone();
        Subject {
            counted: Box::new(move || ledger.closed.load(Ordering::SeqCst)),
            act: Some(taking(&transport)),
            network: Some(network),
            _held: vec![Box::new(transport)],
        }
    }
    .boxed_local()
}

fn unanswered_request(_: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let (transport, network) = over_a_gateway(StreamAnswer::Holds, None, &[], &[HEALTH]).await;
        let failed = Arc::new(Mutex::new(None));
        let (asking, telling) = (transport.clone(), failed.clone());
        tokio::spawn(async move {
            let answered = asking.health_check().await;
            *telling.lock().expect("the outcome") = Some(answered);
        });
        Subject {
            counted: Box::new(move || match &*failed.lock().expect("the outcome") {
                None => 0,
                Some(Err(error)) => {
                    assert_eq!(error.status, None, "the health check was answered: {error}");
                    1
                }
                Some(Ok(answer)) => panic!("the health check was answered: {answer:?}"),
            }),
            act: None,
            network: Some(network),
            _held: vec![Box::new(transport)],
        }
    }
    .boxed_local()
}

fn unanswered_emit(_: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let (transport, network) = over_a_gateway(StreamAnswer::Holds, None, &[], &[EMIT]).await;
        let emitting = transport.clone();
        tokio::spawn(async move {
            let payload = json!({ "annotationId": "ann-1" });
            let _ = emitting
                .emit(
                    "beckon:hover",
                    payload.as_object().cloned().expect("an object"),
                    Envelope::default(),
                )
                .await;
        });
        let ledger = network.ledger.clone();
        Subject {
            counted: Box::new(move || ledger.asked(EMIT)),
            act: None,
            network: Some(network),
            _held: vec![Box::new(transport)],
        }
    }
    .boxed_local()
}

/// How a bus request ended, once it has.
type Ended = Arc<Mutex<Option<Result<Option<Value>, SemiontError>>>>;

/// A bus request of a resource's events, made as the case begins, over a
/// gateway that holds its stream open and refuses every emit; and how it
/// ended, once it has.
async fn refused_request(given: &Map<String, Value>) -> (Arc<HttpTransport>, Network, Ended) {
    let (transport, network) = over_a_gateway(
        StreamAnswer::Holds,
        given_seconds(given, "retryAfterSeconds"),
        &[EMIT],
        &[],
    )
    .await;
    let ended: Ended = Arc::new(Mutex::new(None));
    let (bus, telling) = (Bus::new(transport.clone()), ended.clone());
    tokio::spawn(async move {
        let events = operation("browse:events-requested").expect("an operation of the registry");
        let payload = json!({ "resourceId": "res-1" });
        let asked = bus
            .request_of(
                events,
                payload.as_object().cloned().expect("an object"),
                semiont::timing::BUS_REQUEST_TIMEOUT,
            )
            .await;
        *telling.lock().expect("the outcome") = Some(asked);
    });
    (transport, network, ended)
}

fn refused_bus_request(given: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let (transport, network, ended) = refused_request(&given).await;
        let ledger = network.ledger.clone();
        Subject {
            counted: Box::new(move || {
                // How it fails is what timedOutBusRequest counts.
                if let Some(Ok(answer)) = &*ended.lock().expect("the outcome") {
                    panic!("the request was answered: {answer:?}");
                }
                ledger.asked(EMIT)
            }),
            act: None,
            network: Some(network),
            _held: vec![Box::new(transport)],
        }
    }
    .boxed_local()
}

fn timed_out_bus_request(given: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let (transport, network, ended) = refused_request(&given).await;
        Subject {
            counted: Box::new(move || match &*ended.lock().expect("the outcome") {
                None => 0,
                Some(Err(SemiontError::Bus(failed)))
                    if failed.code == BusRequestErrorCode::Timeout =>
                {
                    1
                }
                Some(other) => panic!("the request ended otherwise: {other:?}"),
            }),
            act: None,
            network: Some(network),
            _held: vec![Box::new(transport)],
        }
    }
    .boxed_local()
}

// ── The issuer ──────────────────────────────────────────────────────────

const REALM: &str = "/realms/semiont";

/// A knowledge base that trusts an issuer, and the issuer, in this process:
/// what a device grant asks. It mints a code that lives 900 seconds, with the
/// interval the case states, and answers each ask of its token endpoint with
/// the next of `answers`, the last repeating.
struct Issuer {
    ledger: Arc<Ledger>,
    origin: String,
    interval_seconds: Option<u64>,
    answers: Vec<String>,
}

impl Issuer {
    fn token_asks(&self) -> usize {
        self.ledger.asked(&format!("{REALM}/token"))
    }
}

async fn issuer_answer(State(issuer): State<Arc<Issuer>>, request: Request) -> Response {
    let (method, path) = (request.method().clone(), request.uri().path().to_owned());
    issuer.ledger.ask(&path);
    axum::body::to_bytes(request.into_body(), usize::MAX)
        .await
        .expect("the request's body");
    let realm = format!("{}{REALM}", issuer.origin);
    match path.strip_prefix(REALM) {
        None if path == "/.well-known/oauth-protected-resource" => Json(json!({
            "resource": issuer.origin,
            "authorization_servers": [realm],
            "bearer_methods_supported": ["header"],
        }))
        .into_response(),
        Some("/.well-known/openid-configuration") => Json(json!({
            "issuer": realm,
            "authorization_endpoint": format!("{realm}/auth"),
            "token_endpoint": format!("{realm}/token"),
            "device_authorization_endpoint": format!("{realm}/device"),
        }))
        .into_response(),
        Some("/device") => {
            let mut minted = json!({
                "device_code": "the-device-code",
                "user_code": "WDJB-MJHT",
                "verification_uri": "http://issuer.test/device",
                "expires_in": 900,
            });
            if let Some(interval) = issuer.interval_seconds {
                minted["interval"] = json!(interval);
            }
            Json(minted).into_response()
        }
        Some("/token") => {
            let asked = issuer.token_asks() - 1;
            let said = &issuer.answers[asked.min(issuer.answers.len() - 1)];
            (StatusCode::BAD_REQUEST, Json(json!({ "error": said }))).into_response()
        }
        _ => issuer.ledger.stray(format!("{method} {path}")),
    }
}

fn device_grant(given: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let answers: Vec<String> = given["answers"]
            .as_array()
            .expect("given.answers")
            .iter()
            .map(|answer| answer.as_str().expect("an answer").to_owned())
            .collect();
        assert!(!answers.is_empty(), "the token endpoint has answers");
        let interval_seconds = given_seconds(&given, "intervalSeconds");
        let ledger = Arc::new(Ledger::default());
        let issued = Arc::new(Mutex::new(None));
        let telling = issued.clone();
        let network = Network::serve(ledger.clone(), move |origin| {
            let issuer = Arc::new(Issuer {
                ledger,
                origin,
                interval_seconds,
                answers,
            });
            *telling.lock().expect("the issuer") = Some(issuer.clone());
            Router::new().fallback(issuer_answer).with_state(issuer)
        })
        .await;
        let issuer = issued
            .lock()
            .expect("the issuer")
            .take()
            .expect("the issuer is serving");
        let target = HttpEndpoint::new("127.0.0.1", network.port, HttpEndpointProtocol::Http);
        tokio::spawn(async move {
            let _ = sign_in_with_device_grant(&target, |_| {}, &http()).await;
        });
        Subject {
            counted: Box::new(move || issuer.token_asks()),
            act: None,
            network: Some(network),
            _held: Vec::new(),
        }
    }
    .boxed_local()
}

// ── A session ───────────────────────────────────────────────────────────

const KB: &str = "kb-alpha";

/// A token issued now, by the wall clock, that lives `lifetime` seconds, told
/// from every other by `n`. Unsigned: nothing here verifies one.
fn token(lifetime: u64, n: usize) -> String {
    let issued = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("after the epoch")
        .as_secs();
    let claims = json!({ "iat": issued, "exp": issued + lifetime, "n": n });
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

fn alice() -> UserResponse {
    serde_json::from_value(json!({
        "did": "did:web:example.org:users:alice", "email": "alice@example.org",
        "name": "Alice", "image": null, "domain": "example.org",
    }))
    .expect("a user")
}

fn renewal(given: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let lifetime = given_seconds(&given, "lifetimeSeconds")
            .expect("a renewal's case states how long its tokens live");
        let storage = Arc::new(InMemorySessionStorage::new());
        store_session(
            storage.as_ref(),
            KB,
            &StoredSession {
                access: token(lifetime, 0),
                refresh: "a-refresh-token".to_owned(),
                client_id: "semiont-cli".to_owned(),
                token_endpoint: "http://issuer.test/realms/semiont/token".to_owned(),
                revocation_endpoint: None,
            },
        )
        .expect("the sign-in is kept");
        let renewals = Arc::new(AtomicUsize::new(0));
        let renewing = renewals.clone();
        let session = SemiontSession::new(SemiontSessionConfig {
            kb: KbTarget::http(KB, "Alpha", "localhost", 4000, HttpEndpointProtocol::Http),
            storage,
            client: create_test_client(TestClientOptions::default()).client,
            token: watch::channel(None).0,
            refresh: Some(Arc::new(move |_holding| {
                let n = renewing.fetch_add(1, Ordering::SeqCst) + 1;
                Box::pin(async move { Ok(Some(token(lifetime, n))) })
            })),
            validate: Some(Arc::new(|_token| Box::pin(async { Ok(alice()) }))),
            on_auth_failed: None,
            on_error: None,
            random: Some(lowest()),
        });
        Subject {
            counted: Box::new(move || renewals.load(Ordering::SeqCst)),
            act: None,
            network: None,
            _held: vec![Box::new(session)],
        }
    }
    .boxed_local()
}

// ── A worker's claims ───────────────────────────────────────────────────

/// A dispatcher with one job: it answers `job:claim` with it.
fn dispatcher(operation: &str, _: &Map<String, Value>) -> Result<Option<Value>, String> {
    match operation {
        "job:claim" => Ok(Some(json!({
            "status": "running",
            "metadata": {
                "id": "job-1",
                "type": "mark",
                "userId": "did:web:example.org:users:alice",
                "created": "2026-10-01T00:00:00.000Z",
                "retryCount": 0,
                "maxRetries": 1,
            },
            "params": { "resourceId": "res-1" },
            "startedAt": "2026-10-01T00:00:01.000Z",
            "progress": {},
        }))),
        other => Err(format!(
            "the dispatcher was asked {other}, which it does not answer"
        )),
    }
}

fn held_job_stall(_: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let transport = FaultyTransport::answering(vec![], dispatcher);
        let client = create_test_client(TestClientOptions {
            transport: Some(transport),
            ..TestClientOptions::default()
        })
        .client;
        let accepts: Vec<JobFilter> = serde_json::from_value(
            json!([{ "jobType": "mark", "params": { "motivation": "highlighting" } }]),
        )
        .expect("a filter");
        let claims = client.job.claim(ClaimOptions::new(accepts));
        let counted = tally(claims.stalled(), Option::is_some);
        let job = match at_once(claims.next()).await.expect("a claim") {
            Some(Ok(job)) => Arc::new(job),
            Some(Err(refusal)) => panic!("the claim was refused: {refusal:?}"),
            None => panic!("the claiming has ended"),
        };
        Subject {
            counted,
            act: Some(Box::new(move || {
                let job = job.clone();
                async move {
                    job.progress(JobProgress::new(50.0))
                        .await
                        .expect("the progress is reported");
                }
                .boxed_local()
            })),
            network: None,
            _held: vec![Box::new(claims), Box::new(client)],
        }
    }
    .boxed_local()
}

// ── Discovery ───────────────────────────────────────────────────────────

/// A launcher's document: one managed knowledge base at the first read, and
/// unchanged at every read after it.
#[derive(Default)]
struct LauncherDocument {
    reads: AtomicUsize,
}

impl DiscoveryTransport for LauncherDocument {
    fn read(&self) -> BoxFuture<'_, DiscoveryRead> {
        let read = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
        Box::pin(async move {
            if read > 1 {
                return DiscoveryRead::Unchanged;
            }
            let managed: DiscoveredKB = serde_json::from_value(json!({
                "host": "localhost", "port": 4000, "placement": "local",
                "managedBy": "semiont-launcher", "did": "did:web:example.org:kb-a",
            }))
            .expect("a managed knowledge base");
            DiscoveryRead::State(DiscoveryState::Managed { kbs: vec![managed] })
        })
    }
}

fn discovery(_: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let document = Arc::new(LauncherDocument::default());
        let mut diffs = subscribe_discovery(document.clone(), semiont::timing::DISCOVERY_INTERVAL);
        tokio::spawn(async move { while diffs.next().await.is_some() {} });
        Subject {
            counted: Box::new(move || document.reads.load(Ordering::SeqCst)),
            act: None,
            network: None,
            _held: Vec::new(),
        }
    }
    .boxed_local()
}

// ── A client's queries and caches ───────────────────────────────────────

/// A knowledge base that answers every `browse:events-requested`.
fn history(operation: &str, asked: &Map<String, Value>) -> Result<Option<Value>, String> {
    match operation {
        "browse:events-requested" => Ok(Some(
            json!({ "events": [], "total": 0, "resourceId": asked["resourceId"] }),
        )),
        other => Err(format!(
            "the knowledge base was asked {other}, which it does not answer"
        )),
    }
}

fn invalidation_window(_: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let transport = FaultyTransport::answering(vec![], history);
        let client = create_test_client(TestClientOptions {
            transport: Some(transport.clone()),
            ..TestClientOptions::default()
        })
        .client;
        let watching = client.browse.events(&as_id("res-1")).watch();
        let hearing = client.clone();
        Subject {
            counted: Box::new(move || {
                transport
                    .request_log()
                    .iter()
                    .filter(|entry| entry.channel == "browse:events-requested")
                    .count()
            }),
            act: Some(Box::new(move || {
                let added = json!({
                    "id": "evt-1", "type": "mark:added", "timestamp": "2026-10-01T12:00:00.000Z",
                    "userId": "did:web:example.org:users:alice", "resourceId": "res-1",
                    "version": 1, "payload": {}, "metadata": { "sequenceNumber": 1 },
                });
                hearing.bus().emit(
                    "mark:added",
                    added.as_object().cloned().expect("an object"),
                    Envelope::default(),
                );
                async {}.boxed_local()
            })),
            network: None,
            _held: vec![Box::new(watching), Box::new(client)],
        }
    }
    .boxed_local()
}

/// A cache's storage: it keeps nothing to begin with, and counts each save.
#[derive(Default)]
struct Saves(AtomicUsize);

impl CachePersister<String, usize> for Saves {
    fn load(&self) -> Option<HashMap<String, usize>> {
        None
    }

    fn save(
        &self,
        _: &HashMap<String, usize>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn save_debounce(_: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let saves = Arc::new(Saves::default());
        let cache = Cache::persisted(
            |key: String| async move {
                Err(format!("a cache that is only written fetched {key}").into())
            },
            saves.clone(),
            semiont::timing::SAVE_DEBOUNCE,
        );
        let changes = Cell::new(0);
        Subject {
            counted: Box::new(move || saves.0.load(Ordering::SeqCst)),
            act: Some(Box::new(move || {
                changes.set(changes.get() + 1);
                cache.set(&"a key".to_owned(), changes.get());
                async {}.boxed_local()
            })),
            network: None,
            _held: Vec::new(),
        }
    }
    .boxed_local()
}

/// A job queue with one job, `job-1`, which it creates when asked and says is
/// running whenever it is asked.
fn job_queue(operation: &str, _: &Map<String, Value>) -> Result<Option<Value>, String> {
    match operation {
        "job:create" => Ok(Some(json!({ "jobId": "job-1" }))),
        "job:status-requested" => Ok(Some(json!({
            "jobId": "job-1",
            "type": "mark",
            "status": "running",
            "userId": "did:web:example.org:users:alice",
            "created": "2026-10-01T00:00:00.000Z",
        }))),
        other => Err(format!(
            "the job queue was asked {other}, which it does not answer"
        )),
    }
}

fn job_follower(_: Map<String, Value>) -> LocalBoxFuture<'static, Subject> {
    async move {
        let transport = FaultyTransport::answering(vec![], job_queue);
        let client = create_test_client(TestClientOptions {
            transport: Some(transport.clone()),
            ..TestClientOptions::default()
        })
        .client;
        let mut following = client
            .mark
            .delegate(&as_id("res-1"), HighlightingJobParams::new());
        tokio::spawn(async move { while following.next().await.is_some() {} });
        let (counting, delivering) = (transport.clone(), transport);
        Subject {
            counted: Box::new(move || {
                counting
                    .emitted()
                    .iter()
                    .filter(|frame| frame.channel == "job:status-requested")
                    .count()
            }),
            act: Some(Box::new(move || {
                let report = json!({
                    "resourceId": "res-1", "jobId": "job-1", "jobType": "mark",
                    "percentage": 10, "progress": { "percentage": 10 },
                });
                delivering.deliver(Frame {
                    channel: "job:report-progress".to_owned(),
                    payload: report.as_object().cloned().expect("an object"),
                    correlation_id: None,
                    scope: None,
                    trace: None,
                });
                async {}.boxed_local()
            })),
            network: None,
            _held: vec![Box::new(client)],
        }
    }
    .boxed_local()
}

/// How this SDK builds each subject the table names.
const SUBJECTS: [(&str, Build); 17] = [
    ("refusedStream", refused_stream),
    ("unansweredStream", unanswered_stream),
    ("degradedStream", degraded_stream),
    ("scopeTaken", scope_taken),
    ("scopeLetGo", scope_let_go),
    ("handoffLinger", handoff_linger),
    ("renewal", renewal),
    ("deviceGrant", device_grant),
    ("heldJobStall", held_job_stall),
    ("discovery", discovery),
    ("invalidationWindow", invalidation_window),
    ("saveDebounce", save_debounce),
    ("jobFollower", job_follower),
    ("unansweredRequest", unanswered_request),
    ("unansweredEmit", unanswered_emit),
    ("refusedBusRequest", refused_bus_request),
    ("timedOutBusRequest", timed_out_bus_request),
];

// ── A case, played ──────────────────────────────────────────────────────

async fn perform(step: &Value, subject: &Subject) -> Result<(), String> {
    let network = subject.network.as_ref();
    if step == "settle" {
        settle(network).await;
    } else if step == "act" {
        let act = subject.act.as_ref().ok_or("the subject has no action")?;
        at_once(act()).await?;
        settle(network).await;
    } else if let Some(passed) = step.get("pass") {
        pass(network, duration_ms(passed)).await;
    } else if let Some(stated) = step.get("counted") {
        settle(network).await;
        if let Some(network) = network {
            let strays = network.ledger.strays.lock().expect("the ledger").clone();
            if !strays.is_empty() {
                return Err(format!(
                    "the gateway was asked what its subject does not have it answer: {strays:?}"
                ));
            }
        }
        let counted = (subject.counted)();
        let stated = stated.as_u64().ok_or("a count is a whole number")?;
        if counted as u64 != stated {
            return Err(format!("counted {counted}, not {stated}"));
        }
    } else {
        return Err("no step this runner performs".to_owned());
    }
    Ok(())
}

async fn play(case: &Value) -> Result<(), String> {
    let given = case.get("given").map_or_else(Map::new, |given| {
        given.as_object().cloned().expect("given is an object")
    });
    let name = case["subject"].as_str().expect("a case's subject");
    let (_, build) = SUBJECTS
        .iter()
        .find(|(subject, _)| *subject == name)
        .ok_or_else(|| format!("no subject {name} this runner builds"))?;
    let subject = build(given).await;
    let mut at_ms = 0;
    for (at, step) in case["steps"]
        .as_array()
        .expect("a case's steps")
        .iter()
        .enumerate()
    {
        perform(step, &subject)
            .await
            .map_err(|broken| format!("steps[{at}] {step}, at {at_ms} ms: {broken}"))?;
        if let Some(passed) = step.get("pass") {
            at_ms += duration_ms(passed);
        }
    }
    Ok(())
}

/// A case on a runtime of its own, whose clock starts paused: what it broke,
/// or what it panicked with.
fn played(case: &Value) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .expect("a runtime");
    catch_unwind(AssertUnwindSafe(|| runtime.block_on(play(case)))).unwrap_or_else(|panic| {
        Err(panic
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| panic.downcast_ref::<&str>().map(|said| (*said).to_owned()))
            .unwrap_or_else(|| "it panicked".to_owned()))
    })
}

// ── The tests ───────────────────────────────────────────────────────────

#[test]
fn this_runner_builds_every_subject_the_table_names_and_no_other() {
    let built: BTreeSet<&str> = SUBJECTS.iter().map(|(subject, _)| *subject).collect();
    let named: BTreeSet<&str> = cases()
        .iter()
        .map(|case| case["subject"].as_str().expect("a case's subject"))
        .collect();
    assert_eq!(built, named);
}

#[test]
fn a_wait_ends_when_its_case_says() {
    let broken: Vec<String> = cases()
        .iter()
        .filter_map(|case| {
            played(case)
                .err()
                .map(|broken| format!("{}: {}: {broken}", case["subject"], case["case"]))
        })
        .collect();
    assert!(broken.is_empty(), "{broken:#?}");
}

#[test]
fn the_runner_fails_a_case_whose_wait_ends_a_millisecond_early() {
    let mut told = cases()
        .iter()
        .find(|case| case["subject"] == "refusedStream")
        .expect("a case of a refused stream")
        .clone();
    // The last millisecond of the first wait: the case is told the stream
    // was opened again in it.
    assert_eq!(told["steps"][2], json!({ "counted": 1 }));
    told["steps"][2] = json!({ "counted": 2 });
    let broken = played(&told).expect_err("the case fails");
    assert!(broken.starts_with("steps[2]"), "{broken}");
}
