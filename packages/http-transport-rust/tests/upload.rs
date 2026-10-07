//! An upload against a stand-in gateway in this process: what the wire cases
//! of the SDK conformance suite cannot stage, because they need a client
//! whose token is renewed while its upload is refused.

use axum::Json;
use axum::Router;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use bytes::Bytes;
use futures::StreamExt;
use semiont::transport::{BoxFuture, ContentTransport, PutBinaryRequest, UploadProgress};
use semiont_http_transport::content::HttpContentTransport;
use semiont_http_transport::transport::{
    HttpTransport, HttpTransportConfig, Timing, TokenRefresher,
};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

/// Each upload that arrived: the credential it carried, and its body.
type Arrived = Arc<Mutex<Vec<(String, Bytes)>>>;

/// Refuses the first upload as one whose token has expired, and accepts
/// every one after it.
async fn upload(
    axum::extract::State(arrived): axum::extract::State<Arrived>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let credential = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let nth = {
        let mut arrived = arrived.lock().unwrap();
        arrived.push((credential, body));
        arrived.len()
    };
    if nth == 1 {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "The token has expired" })),
        )
            .into_response();
    }
    (
        StatusCode::ACCEPTED,
        Json(json!({ "resourceId": "uploaded" })),
    )
        .into_response()
}

struct Renews;

impl TokenRefresher for Renews {
    fn refresh(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async { Some("second".to_owned()) })
    }
}

#[tokio::test]
async fn an_upload_sent_again_with_a_renewed_token_never_reports_less_than_it_last_said() {
    let arrived = Arrived::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .route("/resources", post(upload))
        .layer(axum::extract::DefaultBodyLimit::disable())
        .with_state(arrived.clone());
    let serving = tokio::spawn(async move { axum::serve(listener, router).await });

    let _ = rustls::crypto::ring::default_provider().install_default();
    let transport = HttpTransport::new(HttpTransportConfig {
        base_url: origin,
        token: watch::channel(Some("first".to_owned())).1,
        refresher: Some(Arc::new(Renews)),
        channels: None,
        http: reqwest::Client::new(),
        timing: Timing::default(),
        bookmarks: None,
    });
    let bytes: Bytes = (0..300 * 1024).map(|i| (i % 251) as u8).collect();
    let mut sending = HttpContentTransport::new(&transport).put_binary(PutBinaryRequest::new(
        "Every byte",
        bytes,
        "image/png",
        "file://uploads/every-byte.png",
    ));

    let mut reports: Vec<UploadProgress> = Vec::new();
    while let Some(report) = sending.next().await {
        reports.push(report);
    }
    let created = sending.await.expect("the second sending is accepted");

    assert_eq!(created.resource_id, "uploaded");
    let arrived = arrived.lock().unwrap();
    assert_eq!(
        arrived
            .iter()
            .map(|(credential, _)| credential.as_str())
            .collect::<Vec<_>>(),
        ["Bearer first", "Bearer second"]
    );
    assert_eq!(arrived[0].1.len(), arrived[1].1.len());
    let total = reports[0].total_bytes;
    assert_eq!(total as usize, arrived[1].1.len());
    let mut before = 0;
    for report in &reports {
        assert_eq!(report.total_bytes, total);
        assert!(
            report.bytes_uploaded >= before,
            "reported {} of {total} after {before}",
            report.bytes_uploaded
        );
        before = report.bytes_uploaded;
    }
    assert_eq!(before, total, "the last report is of all of it");
    serving.abort();
}
