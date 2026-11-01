//! The transport makes every request with the `reqwest::Client` the
//! application gives it: its stream, its emits, the gateway's own operations
//! and content. The application's client here is one that marks each request
//! it sends, and the stand-in gateway keeps which requests carried the mark.

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use semiont::testing::as_id;
use semiont::transport::{
    ConnectionState, ContentTransport, Envelope, GatewayOperations, Transport,
};
use semiont_http_transport::content::HttpContentTransport;
use semiont_http_transport::transport::{HttpTransport, HttpTransportConfig, Timing};
use serde_json::json;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

const MARK: &str = "x-callers-client";

/// Each request that arrived: its path, and whether it carried the mark.
type Arrived = Arc<Mutex<Vec<(String, bool)>>>;

async fn gateway(State(arrived): State<Arrived>, uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().to_owned();
    arrived
        .lock()
        .unwrap()
        .push((path.clone(), headers.contains_key(MARK)));
    match path.as_str() {
        "/bus/subscribe" => (
            [(header::CONTENT_TYPE, "text/event-stream")],
            Body::from_stream(futures::stream::pending::<Result<Bytes, Infallible>>()),
        )
            .into_response(),
        "/bus/emit" => (StatusCode::ACCEPTED, Json(json!({}))).into_response(),
        "/api/users/me" => Json(json!({
            "did": "did:web:example.org:users:alice", "email": "alice@example.org",
            "name": "Alice", "image": null, "domain": "example.org",
        }))
        .into_response(),
        "/resources/res-1" => ([(header::CONTENT_TYPE, "text/plain")], "hello").into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[tokio::test]
async fn a_transport_makes_its_stream_its_emits_its_requests_and_its_content_with_its_callers_client()
 {
    let arrived = Arrived::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new().fallback(gateway).with_state(arrived.clone());
    let serving = tokio::spawn(async move { axum::serve(listener, router).await });

    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut marked = reqwest::header::HeaderMap::new();
    marked.insert(MARK, reqwest::header::HeaderValue::from_static("yes"));
    let callers = reqwest::Client::builder()
        .default_headers(marked)
        .build()
        .unwrap();
    let transport = HttpTransport::new(HttpTransportConfig {
        base_url: origin,
        token: watch::channel(Some("a-token".to_owned())).1,
        refresher: None,
        channels: Some(vec!["beckon:focus".to_owned()]),
        http: callers,
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
        .emit("beckon:focus", serde_json::Map::new(), Envelope::default())
        .await
        .expect("the emit is accepted");
    transport
        .get_current_user()
        .await
        .expect("the gateway says who the token is");
    HttpContentTransport::new(&transport)
        .get_binary(&as_id("res-1"))
        .await
        .expect("the content is read");

    let arrived = arrived.lock().unwrap().clone();
    for path in [
        "/bus/subscribe",
        "/bus/emit",
        "/api/users/me",
        "/resources/res-1",
    ] {
        assert!(
            arrived.iter().any(|(made, _)| made == path),
            "{path} never arrived: {arrived:?}"
        );
    }
    assert!(
        arrived.iter().all(|(_, marked)| *marked),
        "a request was not made with the caller's client: {arrived:?}"
    );
    serving.abort();
}
