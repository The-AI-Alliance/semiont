//! A stand-in gateway for the telemetry tests: it keeps the headers each emit
//! arrived with, and writes a frame to the stream a client holds.

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use bytes::Bytes;
use semiont::transport::{ConnectionState, Frame, Transport};
use semiont_http_transport::transport::{HttpTransport, HttpTransportConfig, Timing};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::UnboundedReceiverStream;

/// The channel the client's stream carries.
pub const HEARD: &str = "beckon:focus";
/// The channel the client emits on.
pub const SENT: &str = "beckon:sparkle";

#[derive(Default)]
struct Staged {
    streams: Mutex<Vec<mpsc::UnboundedSender<Bytes>>>,
    emits: Mutex<Vec<HeaderMap>>,
}

async fn subscribe(State(staged): State<Arc<Staged>>) -> Response {
    let (events, stream) = mpsc::unbounded_channel();
    staged.streams.lock().unwrap().push(events);
    let body = UnboundedReceiverStream::new(stream).map(Ok::<Bytes, std::convert::Infallible>);
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(body),
    )
        .into_response()
}

async fn emit(State(staged): State<Arc<Staged>>, headers: HeaderMap) -> Response {
    staged.emits.lock().unwrap().push(headers);
    (StatusCode::ACCEPTED, Json(json!({}))).into_response()
}

pub struct Gateway {
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
    pub async fn start() -> Gateway {
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

    /// A transport to this gateway whose stream is open.
    pub async fn client(&self) -> HttpTransport {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let transport = HttpTransport::new(HttpTransportConfig {
            base_url: self.origin.clone(),
            token: watch::channel(Some("a-token".to_owned())).1,
            refresher: None,
            channels: Some(vec![HEARD.to_owned()]),
            http: reqwest::Client::new(),
            timing: Timing::default(),
            bookmarks: None,
        });
        let mut states = transport.state();
        tokio::time::timeout(
            Duration::from_secs(10),
            states.wait_for(|state| *state == ConnectionState::Open),
        )
        .await
        .expect("the stream opens")
        .expect("the transport is still there");
        transport
    }

    /// The `traceparent` each emit arrived with, in the order they came.
    pub fn traceparents(&self) -> Vec<Option<String>> {
        self.staged
            .emits
            .lock()
            .unwrap()
            .iter()
            .map(|headers| {
                headers
                    .get("traceparent")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
            })
            .collect()
    }

    /// Write a frame on `HEARD`, sent under `traceparent`, to the client's
    /// stream, and answer it as `transport` delivers it.
    pub async fn deliver(&self, transport: &HttpTransport, traceparent: &str) -> Frame {
        let mut frames = transport.frames(HEARD).expect("frames");
        let frame = json!({
            "channel": HEARD,
            "payload": { "annotationId": "a-1", "_trace": { "traceparent": traceparent } },
        });
        let event = Bytes::from(format!("event: bus-event\nid: e-1\ndata: {frame}\n\n"));
        for stream in self.staged.streams.lock().unwrap().iter() {
            let _ = stream.send(event.clone());
        }
        tokio::time::timeout(Duration::from_secs(10), frames.next())
            .await
            .expect("the frame is delivered")
            .expect("the stream is still there")
            .expect("nothing was missed")
    }
}

/// A payload for an emit on `SENT`.
pub fn sparkle() -> serde_json::Map<String, Value> {
    serde_json::Map::from_iter([("annotationId".to_owned(), json!("a-2"))])
}
