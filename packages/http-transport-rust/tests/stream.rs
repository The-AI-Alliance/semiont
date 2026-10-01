//! The transport's stream against a stand-in gateway in this process: what
//! the wire cases of the SDK conformance suite cannot stage, because they
//! need a gateway that misbehaves at a chosen moment. The liveness axioms on
//! the real transport — no stream that could never fire (L1), a request that
//! settles under any schedule of gateway faults (L2), exactly-once delivery
//! across handoffs under generated interleavings (L3), the breadcrumb a frame
//! from a superseded connection leaves (L4) — and the two ways a handoff can
//! go wrong.

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use bytes::Bytes;
use proptest::collection::vec;
use proptest::prelude::{Just, prop_oneof};
use proptest::strategy::Strategy;
use proptest::test_runner::{Config, TestCaseError, TestRunner};
use semiont::bus::{Bus, operation};
use semiont::retry::RetryPolicy;
use semiont::testing::liveness::{DeliverySubject, assert_exactly_once_delivery_on};
use semiont::transport::{BoxFuture, ConnectionState, ResourceHold, Transport};
use semiont_http_transport::transport::{HttpTransport, HttpTransportConfig, Timing};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::UnboundedReceiverStream;

const CHANNEL: &str = "beckon:focus";
const READ: &str = "browse:resource-requested";
const READ_RESULT: &str = "browse:resource-result";
const READ_FAILURE: &str = "browse:resource-failed";

/// What the gateway does with one emit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EmitFault {
    /// Accepts it, and the reply comes.
    Reply,
    /// Accepts it, and the reply comes twice.
    ReplyTwice,
    /// Accepts it, and the reply comes after this many milliseconds.
    ReplyLate(u64),
    /// Accepts it, and nothing ever answers.
    NoReply,
    /// Refuses it, promising to recover.
    Unavailable,
    /// Refuses it outright.
    BadRequest,
}

/// One stream the gateway opened: the subscription it was asked for, and the
/// way to write to it.
struct Opened {
    subscription: Value,
    events: mpsc::UnboundedSender<Bytes>,
}

impl Opened {
    fn write(&self, id: &str, payload: Value) {
        let frame = json!({ "channel": CHANNEL, "payload": payload });
        let _ = self.events.send(Bytes::from(format!(
            "event: bus-event\nid: {id}\ndata: {frame}\n\n"
        )));
    }

    /// Whether the client still holds its end.
    fn open(&self) -> bool {
        !self.events.is_closed()
    }
}

#[derive(Default)]
struct Staged {
    opened: Mutex<Vec<Arc<Opened>>>,
    /// The statuses the next subscribes are refused with.
    refusals: Mutex<VecDeque<StatusCode>>,
    /// What the next subscribe waits for before it is answered.
    held: Mutex<Option<oneshot::Receiver<()>>>,
    /// How many subscribes have arrived, answered or not.
    arrived: Mutex<usize>,
    /// What the gateway does with each emit in turn, round and round; empty,
    /// it accepts each and nothing answers.
    emits: Mutex<(Vec<EmitFault>, usize)>,
}

async fn subscribe(State(staged): State<Arc<Staged>>, Json(subscription): Json<Value>) -> Response {
    *staged.arrived.lock().unwrap() += 1;
    let held = staged.held.lock().unwrap().take();
    if let Some(held) = held {
        let _ = held.await;
    }
    let refusal = staged.refusals.lock().unwrap().pop_front();
    if let Some(status) = refusal {
        return status.into_response();
    }
    let (events, stream) = mpsc::unbounded_channel();
    staged.opened.lock().unwrap().push(Arc::new(Opened {
        subscription,
        events,
    }));
    let body = UnboundedReceiverStream::new(stream).map(Ok::<Bytes, std::convert::Infallible>);
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(body),
    )
        .into_response()
}

async fn emit(State(staged): State<Arc<Staged>>, Json(sent): Json<Value>) -> Response {
    let fault = {
        let mut emits = staged.emits.lock().unwrap();
        let (schedule, made) = &mut *emits;
        *made += 1;
        match schedule.len() {
            0 => EmitFault::NoReply,
            len => schedule[(*made - 1) % len],
        }
    };
    let (copies, after) = match fault {
        EmitFault::Unavailable => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        EmitFault::BadRequest => return StatusCode::BAD_REQUEST.into_response(),
        EmitFault::NoReply => (0, 0),
        EmitFault::Reply => (1, 0),
        EmitFault::ReplyTwice => (2, 0),
        EmitFault::ReplyLate(after) => (1, after),
    };
    if let Some(correlation_id) = sent["correlationId"].as_str().map(str::to_owned) {
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(after)).await;
            let frame = json!({
                "channel": READ_RESULT,
                "correlationId": correlation_id,
                "payload": { "response": "the answer" },
            });
            let event = Bytes::from(format!(
                "event: bus-event\nid: e-{READ_RESULT}:{correlation_id}\ndata: {frame}\n\n"
            ));
            for _ in 0..copies {
                for stream in staged.opened.lock().unwrap().iter() {
                    let _ = stream.events.send(event.clone());
                }
            }
        });
    }
    (StatusCode::ACCEPTED, Json(json!({}))).into_response()
}

/// A gateway that does what a test tells it to.
struct Gateway {
    origin: String,
    staged: Arc<Staged>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Gateway {
    async fn start() -> Gateway {
        let staged = Arc::new(Staged::default());
        let app = Router::new()
            .route("/bus/subscribe", post(subscribe))
            .route("/bus/emit", post(emit))
            .with_state(staged.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a port");
        let origin = format!("http://{}", listener.local_addr().expect("an address"));
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Gateway {
            origin,
            staged,
            server,
        }
    }

    fn opened(&self) -> Vec<Arc<Opened>> {
        self.staged.opened.lock().unwrap().clone()
    }

    fn arrived(&self) -> usize {
        *self.staged.arrived.lock().unwrap()
    }

    /// Write an event to every stream a client still holds.
    fn write(&self, id: &str) {
        for stream in self.opened().iter().filter(|stream| stream.open()) {
            stream.write(id, json!({ "annotationId": id }));
        }
    }

    /// A transport to this gateway, with timing a test does not wait out.
    fn client(&self, linger: Duration) -> HttpTransport {
        // Already installed by another test of this process: one is enough.
        let _ = rustls::crypto::ring::default_provider().install_default();
        HttpTransport::new(HttpTransportConfig {
            base_url: self.origin.clone(),
            token: watch::channel(Some("a-token".to_owned())).1,
            refresher: None,
            channels: Some(
                [CHANNEL, READ_RESULT, READ_FAILURE]
                    .map(str::to_owned)
                    .to_vec(),
            ),
            http: reqwest::Client::new(),
            timing: Timing {
                reconnect: Duration::from_millis(20),
                lazy_remove: Duration::from_millis(20),
                linger,
                emit_retry: RetryPolicy {
                    attempts: 2,
                    initial_delay: Duration::from_millis(10),
                    max_delay: Duration::from_millis(10),
                },
                ..Timing::default()
            },
        })
    }
}

/// Wait, up to ten seconds, for `probe` to hold.
async fn until(what: &str, probe: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !probe() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn reaches(transport: &HttpTransport, state: ConnectionState) {
    let mut states = transport.state();
    tokio::time::timeout(Duration::from_secs(10), states.wait_for(|s| *s == state))
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {state:?}"))
        .expect("the transport is still there");
}

/// Every state the transport is seen in from now on, sampled as it changes.
fn states_of(transport: &HttpTransport) -> Arc<Mutex<Vec<ConnectionState>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut states = transport.state();
    let record = seen.clone();
    tokio::spawn(async move {
        loop {
            record.lock().unwrap().push(*states.borrow_and_update());
            if states.changed().await.is_err() {
                return;
            }
        }
    });
    seen
}

/// The ids of the frames a transport delivers on `CHANNEL`, as they come.
fn deliveries(transport: &HttpTransport) -> Arc<Mutex<Vec<String>>> {
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let mut frames = transport.frames(CHANNEL).expect("frames");
    let record = delivered.clone();
    tokio::spawn(async move {
        while let Some(Ok(frame)) = frames.next().await {
            let id = frame.payload["annotationId"].as_str().unwrap_or_default();
            record.lock().unwrap().push(id.to_owned());
        }
    });
    delivered
}

/// The real transport as a delivery subject: a write is an event the gateway
/// writes to every stream the client holds, and a transition is a changed
/// subscription, which the client hands to a new stream.
struct Wire {
    gateway: Gateway,
    transport: HttpTransport,
    holds: Mutex<Vec<ResourceHold>>,
    delivered: Arc<Mutex<Vec<String>>>,
}

impl Wire {
    async fn open() -> Wire {
        let gateway = Gateway::start().await;
        let transport = gateway.client(Duration::from_millis(60));
        let delivered = deliveries(&transport);
        reaches(&transport, ConnectionState::Open).await;
        Wire {
            gateway,
            transport,
            holds: Mutex::new(Vec::new()),
            delivered,
        }
    }
}

impl DeliverySubject for Wire {
    fn write(&self, event_id: &str) {
        self.gateway.write(event_id);
    }

    fn transition(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let before = self.gateway.opened().len();
            let resource = format!("res-{before}");
            let hold = self.transport.subscribe_to_resource(&resource);
            self.holds.lock().unwrap().push(hold);
            // The handoff has begun once the gateway has the new stream; the
            // client has yet to take it up, and the old one lingers.
            until("the handoff's stream", || {
                self.gateway.opened().len() > before
            })
            .await;
        })
    }

    fn delivered(&self) -> BoxFuture<'_, Vec<String>> {
        Box::pin(async move {
            // Until nothing more arrives for longer than a stream lingers.
            let mut seen = usize::MAX;
            loop {
                let now = self.delivered.lock().unwrap().len();
                if now == seen {
                    break;
                }
                seen = now;
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            self.transport.close().await;
            self.delivered.lock().unwrap().clone()
        })
    }
}

#[test]
fn an_event_written_to_a_live_stream_is_delivered_once_wherever_a_handoff_lands() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("a runtime");
    assert_eq!(
        assert_exactly_once_delivery_on(&runtime, Wire::open, None, 8),
        Ok(())
    );
}

#[tokio::test]
async fn a_frame_from_a_superseded_connection_leaves_a_breadcrumb() {
    semiont::bus_log::capture();
    let gateway = Gateway::start().await;
    let transport = gateway.client(Duration::from_secs(5));
    let delivered = deliveries(&transport);
    reaches(&transport, ConnectionState::Open).await;

    let _hold = transport.subscribe_to_resource("res-1");
    until("the handoff's stream", || gateway.opened().len() == 2).await;
    // Give the client the time to take the new stream up; the old one lingers.
    tokio::time::sleep(Duration::from_millis(100)).await;
    gateway.opened()[0].write("only-the-old", json!({ "annotationId": "only-the-old" }));
    until("the frame", || delivered.lock().unwrap().len() == 1).await;

    let lines = semiont::bus_log::captured();
    assert!(
        lines
            .iter()
            .any(|line| line == "[bus LINGER] beckon:focus delivered on superseded connection"),
        "{lines:?}"
    );
    transport.close().await;
}

#[tokio::test]
async fn a_handoff_that_cannot_open_is_tried_again_and_the_state_stays_open() {
    let gateway = Gateway::start().await;
    let transport = gateway.client(Duration::from_millis(60));
    reaches(&transport, ConnectionState::Open).await;
    let states = states_of(&transport);
    let mut failures = transport.failures();

    gateway
        .staged
        .refusals
        .lock()
        .unwrap()
        .push_back(StatusCode::SERVICE_UNAVAILABLE);
    let _hold = transport.subscribe_to_resource("res-1");
    // The refused connect, then the one that opens.
    until("the handoff to open", || {
        gateway.arrived() == 3 && gateway.opened().len() == 2
    })
    .await;
    let scoped = &gateway.opened()[1].subscription["scoped"];
    assert_eq!(scoped[0]["scope"], "res-1");

    let refused = failures
        .next()
        .await
        .expect("a failure")
        .expect("not lagged");
    assert_eq!(refused.code.as_str(), "unavailable");
    assert_eq!(refused.status, Some(503));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(*states.lock().unwrap(), [ConnectionState::Open]);
    transport.close().await;
}

#[tokio::test]
async fn the_live_stream_ending_during_a_handoff_is_a_drop_the_handoff_recovers() {
    let gateway = Gateway::start().await;
    let transport = gateway.client(Duration::from_millis(60));
    reaches(&transport, ConnectionState::Open).await;

    let (release, held) = oneshot::channel();
    *gateway.staged.held.lock().unwrap() = Some(held);
    let _hold = transport.subscribe_to_resource("res-1");
    until("the handoff's connect", || gateway.arrived() == 2).await;

    // The live stream ends while the handoff's connect is unanswered.
    let states = states_of(&transport);
    gateway.staged.opened.lock().unwrap().clear();
    until("the drop", || {
        states.lock().unwrap().last() == Some(&ConnectionState::Connecting)
    })
    .await;
    assert_eq!(states.lock().unwrap().first(), Some(&ConnectionState::Open));

    let _ = release.send(());
    reaches(&transport, ConnectionState::Open).await;
    // The connect already in flight was the recovery: no third was made.
    assert_eq!(gateway.arrived(), 2);
    assert_eq!(gateway.opened().len(), 1);
    transport.close().await;
}

#[tokio::test]
async fn a_stream_that_could_never_fire_is_refused_and_an_open_one_ends_when_the_transport_closes()
{
    let gateway = Gateway::start().await;
    let transport = gateway.client(Duration::from_millis(60));
    // A channel this stream does not name can never deliver: said at the
    // call, not left as a stream that is silent for ever.
    let refused = transport
        .frames("job:queued")
        .err()
        .expect("a channel the stream does not carry is refused");
    assert_eq!(refused.code.as_str(), "bus.unsubscribed");
    // A resource-scoped channel may fire once a scope is held.
    let mut scoped = transport.frames("mark:added").expect("a scoped channel");
    let mut global = transport.frames(CHANNEL).expect("a global channel");
    transport.close().await;
    assert!(scoped.next().await.is_none());
    assert!(global.next().await.is_none());
    assert_eq!(*transport.state().borrow(), ConnectionState::Closed);
}

fn emit_faults() -> impl Strategy<Value = Vec<EmitFault>> {
    vec(
        prop_oneof![
            Just(EmitFault::Reply),
            Just(EmitFault::ReplyTwice),
            (1u64..=40).prop_map(EmitFault::ReplyLate),
            Just(EmitFault::NoReply),
            Just(EmitFault::Unavailable),
            Just(EmitFault::BadRequest),
        ],
        1..=6,
    )
}

/// L2 on the wire: whatever the gateway does with each emit, three requests
/// made one after another each settle, with an answer or a failure, inside
/// their deadline and the emit's budget.
#[test]
fn a_request_settles_whatever_the_gateway_does_with_its_emit() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("a runtime");
    let within = Duration::from_millis(150);
    let bound = Duration::from_secs(3);
    let mut runner = TestRunner::new(Config {
        cases: 12,
        failure_persistence: None,
        ..Config::default()
    });
    let outcome = runner.run(&emit_faults(), |schedule| {
        runtime
            .block_on(async {
                let gateway = Gateway::start().await;
                *gateway.staged.emits.lock().unwrap() = (schedule.clone(), 0);
                let transport = gateway.client(Duration::from_millis(60));
                let bus = Bus::new(Arc::new(transport.clone()));
                let read = operation(READ).expect("a registry operation");
                for request in 0..3 {
                    let asked = bus.request_of(
                        read,
                        json!({ "resourceId": "r1" })
                            .as_object()
                            .cloned()
                            .expect("an object"),
                        within,
                    );
                    if tokio::time::timeout(bound, asked).await.is_err() {
                        return Err(format!(
                            "L2: request #{request} did not settle within {}ms under {schedule:?}",
                            bound.as_millis()
                        ));
                    }
                }
                transport.close().await;
                Ok(())
            })
            .map_err(TestCaseError::fail)
    });
    assert_eq!(outcome.map_err(|failure| failure.to_string()), Ok(()));
}
