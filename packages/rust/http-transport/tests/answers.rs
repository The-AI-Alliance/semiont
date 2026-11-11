//! An answer that is not its declared body, against a stand-in gateway in
//! this process: what the wire cases of the SDK conformance suite cannot
//! stage, because the gateway answers only its declared bodies.

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use semiont::channels::BRIDGED_CHANNELS;
use semiont::errors::{TransportError, TransportErrorCode};
use semiont::transport::{GatewayOperations, Transport};
use semiont_http_transport::transport::{HttpTransport, HttpTransportConfig, Timing};
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

/// The media type and the body the stand-in answers `GET /api/users/me` with.
type Answering = Arc<Mutex<(&'static str, &'static str)>>;

async fn gateway(State(answering): State<Answering>, uri: Uri) -> Response {
    match uri.path() {
        "/bus/subscribe" => (
            [(header::CONTENT_TYPE, "text/event-stream")],
            Body::from_stream(futures::stream::pending::<Result<Bytes, Infallible>>()),
        )
            .into_response(),
        "/api/users/me" => {
            let (media_type, body) = *answering.lock().unwrap();
            ([(header::CONTENT_TYPE, media_type)], body).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[tokio::test]
async fn an_answer_that_is_not_its_declared_body_fails_as_error_naming_its_first_fault_and_is_reported()
 {
    let answering = Answering::new(Mutex::new(("application/json", "{}")));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .fallback(gateway)
        .with_state(answering.clone());
    let serving = tokio::spawn(async move { axum::serve(listener, router).await });

    let _ = rustls::crypto::ring::default_provider().install_default();
    let transport = HttpTransport::new(HttpTransportConfig {
        base_url: origin,
        token: watch::channel(Some("a-token".to_owned())).1,
        refresher: None,
        channels: BRIDGED_CHANNELS.iter().map(ToString::to_string).collect(),
        http: reqwest::Client::new(),
        timing: Timing::default(),
        random: None,
    });
    let mut failures = transport.failures();

    for (media_type, body, said) in [
        (
            "application/json",
            r#"{"did":"did:web:example.org:users:alice","email":null,"name":null,"image":null}"#,
            "it has no `domain`",
        ),
        (
            "application/json",
            r#"{"did":"did:web:example.org:users:alice","email":null,"name":null,"image":7,"domain":"example.org"}"#,
            "its `image` is malformed",
        ),
        ("text/html", "<html>a proxy page</html>", "it is malformed"),
    ] {
        *answering.lock().unwrap() = (media_type, body);
        let refused = TransportError {
            code: TransportErrorCode::Error,
            status: Some(200),
            message: format!("GET /api/users/me answered what is not its declared body: {said}"),
            retry_after: None,
        };

        let failed = transport
            .get_current_user()
            .await
            .expect_err("an answer with a fault is refused");
        assert_eq!(failed, refused, "{body}");
        let reported = tokio::time::timeout(Duration::from_secs(5), failures.next())
            .await
            .expect("the refusal is reported")
            .expect("a failure")
            .expect("not lagged");
        assert_eq!(reported, refused, "{body}");
    }
    transport.close().await;
    serving.abort();
}
