//! An upload against a stand-in gateway in this process: what the wire cases
//! of the SDK conformance suite cannot stage, because they need a client
//! whose token is renewed while its upload is refused, or one whose upload
//! is cancelled; and when an upload is sent once more, and when it is not.

use axum::Json;
use axum::Router;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use bytes::Bytes;
use futures::StreamExt;
use semiont::timing::REQUEST_RETRY_PAUSE;
use semiont::transport::{BoxFuture, ContentTransport, PutBinaryRequest, UploadProgress};
use semiont_http_transport::content::HttpContentTransport;
use semiont_http_transport::transport::{
    HttpTransport, HttpTransportConfig, Timing, TokenRefresher,
};
use serde_json::json;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{Notify, watch};

/// Each upload that arrived: the credential it carried, its key, and its
/// body.
type Arrived = Arc<Mutex<Vec<(String, String, Bytes)>>>;

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
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let nth = {
        let mut arrived = arrived.lock().unwrap();
        arrived.push((credential, key, body));
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

    let transport = transport(origin, Some(Arc::new(Renews)));
    let bytes: Bytes = (0..300 * 1024).map(|i| (i % 251) as u8).collect();
    let content = HttpContentTransport::new(&transport);
    let mut sending = content.put_binary(PutBinaryRequest::new(
        "Every byte",
        bytes.clone(),
        "image/png",
        "file://uploads/every-byte.png",
    ));

    let mut reports: Vec<UploadProgress> = Vec::new();
    while let Some(report) = sending.next().await {
        reports.push(report);
    }
    let created = sending.await.expect("the second sending is accepted");

    assert_eq!(created.resource_id, "uploaded");
    content
        .put_binary(PutBinaryRequest::new(
            "Another",
            bytes,
            "image/png",
            "file://uploads/another.png",
        ))
        .await
        .expect("a second upload is accepted");
    let arrived = arrived.lock().unwrap();
    assert_eq!(
        arrived
            .iter()
            .map(|(credential, _, _)| credential.as_str())
            .collect::<Vec<_>>(),
        ["Bearer first", "Bearer second", "Bearer first"]
    );
    assert!(!arrived[0].1.is_empty(), "an upload carries a key");
    assert_eq!(
        arrived[0].1, arrived[1].1,
        "an upload sent again carries the key it was first sent with"
    );
    assert_ne!(
        arrived[1].1, arrived[2].1,
        "a second upload carries a key of its own"
    );
    assert_eq!(arrived[0].2.len(), arrived[1].2.len());
    let total = reports[0].total_bytes;
    assert_eq!(total as usize, arrived[1].2.len());
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

/// A transport whose token is `first`.
fn transport(origin: String, refresher: Option<Arc<dyn TokenRefresher>>) -> HttpTransport {
    let _ = rustls::crypto::ring::default_provider().install_default();
    HttpTransport::new(HttpTransportConfig {
        base_url: origin,
        token: watch::channel(Some("first".to_owned())).1,
        refresher,
        channels: None,
        http: reqwest::Client::new(),
        timing: Timing::default(),
        bookmarks: None,
    })
}

fn every_byte() -> PutBinaryRequest {
    let bytes: Bytes = (0..100 * 1024).map(|i| (i % 251) as u8).collect();
    PutBinaryRequest::new(
        "Every byte",
        bytes,
        "image/png",
        "file://uploads/every-byte.png",
    )
}

/// What the scripted gateway does with one upload.
enum Answer {
    /// 202, and the id of the resource made.
    Accepted,
    /// This status, and an ErrorResponse.
    Refused(u16),
    /// Nothing: it reads the upload whole and closes its connection.
    Unanswered,
}

/// An upload as it arrived: its `Idempotency-Key` and its body.
type Sending = (Option<String>, Bytes);

/// A stand-in gateway that does with each upload, in turn, what its script
/// says, and answers anything else 404. It speaks HTTP/1.1 by hand, so that
/// it can close a connection without answering.
struct Scripted {
    origin: String,
    arrived: Arc<Mutex<Vec<Sending>>>,
    /// Told of each upload once it has been read whole.
    arrival: Arc<Notify>,
    serving: tokio::task::JoinHandle<()>,
}

impl Scripted {
    async fn start(script: Vec<Answer>) -> Scripted {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let arrived = Arc::new(Mutex::new(Vec::new()));
        let arrival = Arc::new(Notify::new());
        let script = Arc::new(Mutex::new(VecDeque::from(script)));
        let serving = tokio::spawn({
            let arrived = arrived.clone();
            let arrival = arrival.clone();
            async move {
                while let Ok((connection, _)) = listener.accept().await {
                    tokio::spawn(serve(
                        connection,
                        script.clone(),
                        arrived.clone(),
                        arrival.clone(),
                    ));
                }
            }
        });
        Scripted {
            origin,
            arrived,
            arrival,
            serving,
        }
    }

    fn arrived(&self) -> Vec<Sending> {
        self.arrived.lock().unwrap().clone()
    }
}

impl Drop for Scripted {
    fn drop(&mut self) {
        self.serving.abort();
    }
}

async fn serve(
    connection: TcpStream,
    script: Arc<Mutex<VecDeque<Answer>>>,
    arrived: Arc<Mutex<Vec<Sending>>>,
    arrival: Arc<Notify>,
) {
    let mut connection = BufReader::new(connection);
    while let Some((target, key, body)) = read_request(&mut connection).await {
        let answer = if target == "POST /resources" {
            arrived.lock().unwrap().push((key, body));
            arrival.notify_one();
            script
                .lock()
                .unwrap()
                .pop_front()
                .expect("the script has an answer for every upload")
        } else {
            Answer::Refused(404)
        };
        let (status, said) = match answer {
            Answer::Accepted => (202, json!({ "resourceId": "uploaded" })),
            Answer::Refused(status) => (status, json!({ "error": format!("refused {status}") })),
            Answer::Unanswered => return,
        };
        let said = said.to_string();
        let reason = reqwest::StatusCode::from_u16(status)
            .unwrap()
            .canonical_reason()
            .expect("a status with a reason");
        let response = format!(
            "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{said}",
            said.len()
        );
        if connection.write_all(response.as_bytes()).await.is_err() {
            return;
        }
    }
}

/// One request off `connection`: its method and path, its
/// `Idempotency-Key`, and its body by its `Content-Length`. None once the
/// client has closed the connection.
async fn read_request(
    connection: &mut BufReader<TcpStream>,
) -> Option<(String, Option<String>, Bytes)> {
    let mut line = String::new();
    if connection.read_line(&mut line).await.ok()? == 0 {
        return None;
    }
    let (target, _version) = line.trim_end().rsplit_once(' ')?;
    let target = target.to_owned();
    let mut key = None;
    let mut length = 0;
    loop {
        let mut header = String::new();
        if connection.read_line(&mut header).await.ok()? == 0 {
            return None;
        }
        let Some((name, value)) = header.trim_end().split_once(':') else {
            break;
        };
        match name.to_ascii_lowercase().as_str() {
            "content-length" => length = value.trim().parse().expect("a length"),
            "idempotency-key" => key = Some(value.trim().to_owned()),
            _ => {}
        }
    }
    let mut body = vec![0; length];
    connection.read_exact(&mut body).await.ok()?;
    Some((target, key, Bytes::from(body)))
}

/// The two sendings of one upload carry its one key, and the same fields
/// and bytes.
fn sent_once_more(arrived: &[Sending]) {
    assert_eq!(arrived.len(), 2, "the upload is sent once more");
    assert!(arrived[0].0.is_some(), "an upload carries a key");
    assert_eq!(
        arrived[0], arrived[1],
        "the upload is sent again with its key, fields and bytes"
    );
}

#[tokio::test]
async fn an_upload_answered_with_a_status_that_promises_recovery_is_sent_once_more() {
    let gateway = Scripted::start(vec![Answer::Refused(503), Answer::Accepted]).await;
    let transport = transport(gateway.origin.clone(), None);

    let created = HttpContentTransport::new(&transport)
        .put_binary(every_byte())
        .await
        .expect("the second sending is accepted");

    assert_eq!(created.resource_id, "uploaded");
    sent_once_more(&gateway.arrived());
}

#[tokio::test]
async fn an_upload_that_got_no_answer_is_sent_once_more() {
    let gateway = Scripted::start(vec![Answer::Unanswered, Answer::Accepted]).await;
    let transport = transport(gateway.origin.clone(), None);

    let created = HttpContentTransport::new(&transport)
        .put_binary(every_byte())
        .await
        .expect("the second sending is accepted");

    assert_eq!(created.resource_id, "uploaded");
    sent_once_more(&gateway.arrived());
}

#[tokio::test]
async fn an_upload_refused_as_malformed_or_unprocessable_is_not_sent_again() {
    for (status, code) in [(400, "bad-request"), (422, "unprocessable")] {
        let gateway = Scripted::start(vec![Answer::Refused(status)]).await;
        let transport = transport(gateway.origin.clone(), None);

        let refused = HttpContentTransport::new(&transport)
            .put_binary(every_byte())
            .await
            .expect_err("the upload is refused");

        assert_eq!(refused.status, Some(status));
        assert_eq!(refused.code.as_str(), code);
        assert_eq!(gateway.arrived().len(), 1, "a {status} is not sent again");
    }
}

#[tokio::test]
async fn a_cancelled_upload_is_not_sent_again() {
    let gateway = Scripted::start(vec![Answer::Refused(503), Answer::Accepted]).await;
    let transport = transport(gateway.origin.clone(), None);
    let sending = HttpContentTransport::new(&transport).put_binary(every_byte());

    // Leaving the select drops the upload: that is its cancelling.
    tokio::select! {
        _ = sending.into_future() => panic!("the upload ended before it was cancelled"),
        () = gateway.arrival.notified() => {}
    }
    tokio::time::sleep(REQUEST_RETRY_PAUSE * 3).await;

    assert_eq!(
        gateway.arrived().len(),
        1,
        "a cancelled upload is not sent again"
    );
}
