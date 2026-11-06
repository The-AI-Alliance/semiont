//! The gateway's calls onto the Archivist's HTTP surface
//! (protocol/specs/src/archivist/openapi.json): an upload is stored and recorded there,
//! bytes, a resource's JSON-LD description, its annotations and its anchored text are read
//! back, and a scope's persisted events are read for a replay. The gateway
//! parses none of it; it forwards, and maps the answer onto its own
//! responses. It reaches the Archivist as itself, with its service account's
//! token, and waits for it as the Archivist's document says (its
//! `x-semiont-limits`).

use crate::http::ApiError;
use axum::body::Body;
use axum::http::StatusCode;
use bytes::Bytes;
use futures::{Stream, StreamExt, TryStreamExt};
use opentelemetry::KeyValue;
use opentelemetry::trace::SpanKind;
use semiont::identity::encode_uri_component;
use semiont::types::ResourceId;
use semiont_core::spec::{Spec, spec};
use semiont_http_transport::service_account::{Credential, ServiceToken};
use semiont_observability::logging;
use serde_json::{Value, json};
use std::task::Poll;
use std::time::Duration;

/// The Archivist operations the gateway calls. The embedded Archivist
/// document must declare each, or the gateway does not start.
const CALLS: [(&str, &str); 6] = [
    ("POST", "/resources"),
    ("GET", "/resources/{id}/content"),
    ("GET", "/resources/{id}/jsonld"),
    ("GET", "/resources/{id}/annotations"),
    ("GET", "/resources/{id}/anchored-text"),
    ("GET", "/events/{resourceId}"),
];

pub struct Archivist {
    base: String,
    /// The reads: a read that got no answer sent once more, unless its
    /// connection was not taken in time, and its answer waited for as
    /// `waits` says.
    reads: reqwest::Client,
    /// The uploads: an answer waited for `readSeconds` from the upload's last
    /// byte.
    uploads: reqwest::Client,
    waits: Waits,
    token: ServiceToken,
}

const UNAVAILABLE: &str = "Content store unavailable";

fn unavailable() -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, UNAVAILABLE)
}

fn client(fields: Value) -> Value {
    let mut fields = fields;
    fields["component"] = json!("archivist-client");
    fields
}

/// How long the gateway waits for the Archivist, as the Archivist's document
/// states it (`x-semiont-limits`).
#[derive(Clone, Copy)]
struct Waits {
    /// `connectSeconds`: for a connection to be taken.
    connect: Duration,
    /// `readSeconds`: for each next part of an answer and, with `connect`,
    /// for a read's answer to begin.
    read: Duration,
}

impl Waits {
    fn stated() -> Result<Waits, String> {
        let limit = |key: &str| {
            spec().archivist["x-semiont-limits"][key]
                .as_u64()
                .map(Duration::from_secs)
                .ok_or_else(|| format!("The Archivist's document states no x-semiont-limits.{key}"))
        };
        Ok(Waits {
            connect: limit("connectSeconds")?,
            read: limit("readSeconds")?,
        })
    }

    /// A read's answer, begun within `connect` and `read` together of the
    /// read's first send, its retry included: the retry happens inside
    /// `send`. Past that, the read is unanswered.
    async fn answer(self, read: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
        let begun_within = self.connect + self.read;
        match tokio::time::timeout(begun_within, read.send()).await {
            Ok(answered) => answered.map_err(|error| logging::chain(&error)),
            Err(_) => Err(format!(
                "no answer begun {}s after the read was first sent",
                begun_within.as_secs()
            )),
        }
    }

    /// An answer's parts as they arrive, each waited for `read` from when it
    /// is asked for: one that does not come within it ends the answer with an
    /// error, as a stall.
    fn parts(
        self,
        answer: reqwest::Response,
    ) -> impl Stream<Item = Result<Bytes, String>> + Send + 'static {
        let read = self.read;
        futures::stream::unfold(
            Some(Box::pin(answer.bytes_stream())),
            move |parts| async move {
                let mut parts = parts?;
                match tokio::time::timeout(read, parts.next()).await {
                    Ok(Some(Ok(part))) => Some((Ok(part), Some(parts))),
                    Ok(Some(Err(error))) => Some((Err(logging::chain(&error)), None)),
                    Ok(None) => None,
                    Err(_) => Some((
                        Err(format!(
                            "no part of the answer came within {}s",
                            read.as_secs()
                        )),
                        None,
                    )),
                }
            },
        )
    }

    /// An answer whole, each part waited for as `parts` waits, read as JSON.
    async fn json(self, answer: reqwest::Response) -> Result<Value, String> {
        let whole: Vec<u8> = self.parts(answer).map_ok(Vec::from).try_concat().await?;
        serde_json::from_slice(&whole).map_err(|error| error.to_string())
    }
}

/// The retry policy of the client the gateway reads from the Archivist with:
/// a read that got no answer — its connection was refused, or broke or
/// closed before a response came back, as a pooled connection the Archivist
/// closes just as a read is written to it does — is sent once more. A read
/// whose connection was not taken within `connectSeconds` is not: the
/// Archivist cannot be reached, and a second attempt would only wait as long
/// again. An answer is never asked again, whatever its status. The wait for
/// a read's answer to begin is kept outside the policy (`Waits::answer`), so
/// it counts from the first send, the retry inside it.
fn read_retry(host: &str) -> reqwest::retry::Builder {
    reqwest::retry::for_host(host.to_owned())
        .max_retries_per_request(1)
        // With one retry a read, the most retries can add is a second read
        // to a store that is not answering; a budget would only take some
        // reads' one retry away.
        .no_budget()
        .classify_fn(|attempt| {
            let unanswered = attempt.status().is_none();
            if unanswered && !attempt.error().is_some_and(timed_out_connecting) {
                attempt.retryable()
            } else {
                attempt.success()
            }
        })
}

/// The client the gateway reads from the Archivist at `host` with. It keeps
/// no timer on an answer: `Waits` does.
fn reads_client(host: &str, waits: Waits) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .retry(read_retry(host))
        .connect_timeout(waits.connect)
}

/// Whether a call failed because its connection was not taken in time.
fn timed_out_connecting(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<reqwest::Error>()
        .is_some_and(|error| error.is_connect() && error.is_timeout())
}

/// Where the gateway's requests to the Archivist at `host` and `port` go.
fn origin(host: &str, port: u16) -> String {
    format!("http://{host}:{port}")
}

/// Every operation the gateway calls is one the Archivist's document declares.
pub fn undeclared_calls() -> Vec<String> {
    let declared = Spec::operations_of(&spec().archivist);
    CALLS
        .iter()
        .filter(|(method, path)| !declared.iter().any(|(m, p)| m == method && p == path))
        .map(|(method, path)| format!("{method} {path}"))
        .collect()
}

fn path(template: &str, value: &str) -> String {
    let start = template.find('{').expect("the template has a parameter");
    let end = template[start..].find('}').expect("the parameter closes") + start;
    format!(
        "{}{}{}",
        &template[..start],
        encode_uri_component(value),
        &template[end + 1..]
    )
}

async fn in_client_span<T>(operation: &str, work: impl std::future::Future<Output = T>) -> T {
    semiont_telemetry::in_span(
        format!("archivist.{operation}"),
        SpanKind::Client,
        vec![KeyValue::new("peer.service", "archivist")],
        opentelemetry::Context::current(),
        work,
    )
    .await
}

impl Archivist {
    /// The Archivist at `host` and `port`, reached on clients of its own; the
    /// service account's token is asked for on `http`, the issuer's client.
    pub fn new(
        host: &str,
        port: u16,
        credential: Credential,
        http: reqwest::Client,
    ) -> Result<Archivist, String> {
        let waits = Waits::stated()?;
        let built = |builder: reqwest::ClientBuilder| {
            builder
                .build()
                .map_err(|e| format!("cannot build the Archivist's HTTP client: {e}"))
        };
        Ok(Archivist {
            base: origin(host, port),
            reads: built(reads_client(host, waits))?,
            uploads: built(reqwest::Client::builder().connect_timeout(waits.connect))?,
            waits,
            token: ServiceToken::new(credential, http),
        })
    }

    async fn authorized(&self, operation: &str) -> Result<String, ApiError> {
        self.token.authorization().await.map_err(|error| {
            logging::error(
                "The gateway could not obtain its own token for the Archivist",
                client(json!({ "operation": operation, "error": error.to_string() })),
            );
            unavailable()
        })
    }

    /// Forward an upload, streamed and untouched, naming the principal this
    /// gateway verified, with the upload's `Idempotency-Key`; answer the id the
    /// Archivist recorded it under. Its 400 and 500 come back with its
    /// message, and its 422 as `unprocessable`; anything else is a 503.
    pub async fn record_upload(
        &self,
        body: Body,
        content_type: &str,
        principal: &str,
        roles: &[String],
        key: &str,
    ) -> Result<ResourceId, ApiError> {
        let authorization = self.authorized("resources.record").await?;
        // The wait for the Archivist's answer begins at the upload's last
        // byte: its own sending takes as long as it takes.
        let (sent, sent_whole) = tokio::sync::oneshot::channel::<()>();
        let mut sent = Some(sent);
        let upload = body
            .into_data_stream()
            .chain(futures::stream::poll_fn(move |_| {
                if let Some(sent) = sent.take() {
                    let _ = sent.send(());
                }
                Poll::Ready(None)
            }));
        let mut request = self
            .uploads
            .post(format!("{}/resources", self.base))
            .header("authorization", authorization)
            .header("content-type", content_type)
            .header("semiont-principal", principal)
            .header("idempotency-key", key)
            .body(reqwest::Body::wrap_stream(upload));
        if !roles.is_empty() {
            request = request.header("semiont-roles", roles.join(","));
        }
        let read = self.waits.read;
        let unanswered = async move {
            let _ = sent_whole.await;
            tokio::time::sleep(read).await;
        };
        let response = in_client_span("resources.record", async {
            tokio::select! {
                answered = request.send() => answered.map_err(|e| logging::chain(&e)),
                () = unanswered => Err(format!(
                    "no answer {}s after the upload's last byte",
                    read.as_secs()
                )),
            }
        })
        .await
        .map_err(|error| {
            logging::error(
                "Archivist unreachable for an upload",
                client(json!({ "error": error })),
            );
            unavailable()
        })?;
        let status = response.status();
        let Ok(answer) = tokio::time::timeout(read, response.json::<Value>()).await else {
            logging::error(
                "Archivist's answer to an upload stopped coming",
                client(json!({ "status": status.as_u16() })),
            );
            return Err(unavailable());
        };
        let answer = answer.ok();
        if status.is_success() {
            let named = answer.as_ref().and_then(|a| a["resourceId"].as_str());
            if let Some(id) = named.and_then(|id| ResourceId::new(id).ok()) {
                return Ok(id);
            }
            logging::error(
                "Archivist recorded an upload and answered no resource id",
                client(json!({ "status": status.as_u16(), "resourceId": named })),
            );
            return Err(unavailable());
        }
        let message = answer.as_ref().and_then(|a| a["error"].as_str());
        if let Some(message) = message {
            if status == StatusCode::BAD_REQUEST || status == StatusCode::INTERNAL_SERVER_ERROR {
                return Err(ApiError::new(status, message));
            }
            if status == StatusCode::UNPROCESSABLE_ENTITY {
                return Err(ApiError::unprocessable(message));
            }
        }
        logging::error(
            "Archivist upload failed",
            client(json!({ "status": status.as_u16() })),
        );
        Err(unavailable())
    }

    /// A resource's linked-data description; `None` when the Archivist holds no such resource.
    pub async fn describe(&self, resource_id: &ResourceId) -> Result<Option<Value>, ApiError> {
        let authorization = self.authorized("resources.describe").await?;
        let request = self
            .reads
            .get(format!(
                "{}{}",
                self.base,
                path("/resources/{id}/jsonld", resource_id)
            ))
            .header("authorization", authorization);
        let response = in_client_span("resources.describe", self.waits.answer(request))
            .await
            .map_err(|error| {
                logging::error(
                    "Archivist unreachable for a description",
                    client(json!({ "resourceId": resource_id, "error": error })),
                );
                unavailable()
            })?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(None),
            status if status.is_success() => {
                self.waits.json(response).await.map(Some).map_err(|error| {
                    logging::error(
                        "Archivist description is not JSON",
                        client(json!({ "resourceId": resource_id, "error": error })),
                    );
                    unavailable()
                })
            }
            status => {
                logging::error(
                    "Archivist description failed",
                    client(json!({ "resourceId": resource_id, "status": status.as_u16() })),
                );
                Err(unavailable())
            }
        }
    }

    /// A resource's annotations: the Archivist's answer, streamed as it
    /// arrives and never read; `None` when the Archivist holds no such resource.
    pub async fn annotations(&self, resource_id: &ResourceId) -> Result<Option<Body>, ApiError> {
        let authorization = self.authorized("resources.annotations").await?;
        let request = self
            .reads
            .get(format!(
                "{}{}",
                self.base,
                path("/resources/{id}/annotations", resource_id)
            ))
            .header("authorization", authorization);
        let response = in_client_span("resources.annotations", self.waits.answer(request))
            .await
            .map_err(|error| {
                logging::error(
                    "Archivist unreachable for a resource's annotations",
                    client(json!({ "resourceId": resource_id, "error": error })),
                );
                unavailable()
            })?;
        match response.status() {
            StatusCode::OK => Ok(Some(Body::from_stream(self.waits.parts(response)))),
            StatusCode::NOT_FOUND => Ok(None),
            status => {
                logging::error(
                    "Archivist annotations read failed",
                    client(json!({ "resourceId": resource_id, "status": status.as_u16() })),
                );
                Err(unavailable())
            }
        }
    }

    /// A resource's anchored text: the Archivist's answer, streamed as it
    /// arrives and never read.
    pub async fn anchored_text(&self, resource_id: &ResourceId) -> Result<Body, ApiError> {
        let authorization = self.authorized("resources.anchored_text").await?;
        let request = self
            .reads
            .get(format!(
                "{}{}",
                self.base,
                path("/resources/{id}/anchored-text", resource_id)
            ))
            .header("authorization", authorization);
        let response = in_client_span("resources.anchored_text", self.waits.answer(request))
            .await
            .map_err(|error| {
                logging::error(
                    "Archivist unreachable for an anchored text",
                    client(json!({ "resourceId": resource_id, "error": error })),
                );
                unavailable()
            })?;
        let status = response.status();
        if status != StatusCode::OK {
            logging::error(
                "Archivist anchored-text read failed",
                client(json!({ "resourceId": resource_id, "status": status.as_u16() })),
            );
            return Err(unavailable());
        }
        Ok(Body::from_stream(self.waits.parts(response)))
    }

    /// A representation's bytes, streamed as they arrive, and their media
    /// type. The 404's `code` says which half of the lookup failed.
    pub async fn content(&self, resource_id: &ResourceId) -> Result<(Body, String), ApiError> {
        let authorization = self.authorized("content.get").await?;
        let request = self
            .reads
            .get(format!(
                "{}{}",
                self.base,
                path("/resources/{id}/content", resource_id)
            ))
            .header("authorization", authorization);
        let response = in_client_span("content.get", self.waits.answer(request))
            .await
            .map_err(|error| {
                logging::error(
                    "Archivist content read unreachable",
                    client(json!({ "resourceId": resource_id, "error": error })),
                );
                unavailable()
            })?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            if let Ok(answer) = self.waits.json(response).await
                && spec().validator("RepresentationNotFound").is_valid(&answer)
            {
                let message = if answer["code"] == "representation" {
                    "Resource representation not found"
                } else {
                    "Resource not found"
                };
                return Err(ApiError::new(StatusCode::NOT_FOUND, message));
            }
            logging::error(
                "Archivist answered a 404 that is not a RepresentationNotFound",
                client(json!({ "resourceId": resource_id })),
            );
            return Err(unavailable());
        }
        if !status.is_success() {
            logging::error(
                "Archivist content read failed",
                client(json!({ "resourceId": resource_id, "status": status.as_u16() })),
            );
            return Err(unavailable());
        }
        let media_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty())
            .unwrap_or("application/octet-stream")
            .to_owned();
        Ok((Body::from_stream(self.waits.parts(response)), media_type))
    }

    /// A resource's persisted events from `from_sequence`, inclusive: one
    /// answer of the Archivist's after another, each from the sequence after
    /// the last event of the one before, until the stream's last event. An
    /// answer that is not the ArchivistEventsResponse the spec declares is a
    /// failure: read on trust, it would drop an event it could not route.
    pub async fn replay(
        &self,
        resource_id: &str,
        from_sequence: u64,
    ) -> Result<Vec<Value>, String> {
        let mut events = Vec::new();
        let mut from = from_sequence;
        loop {
            let (answered, last) = self.events_from(resource_id, from).await?;
            let reached = answered
                .last()
                .and_then(|event| event["metadata"]["sequenceNumber"].as_u64());
            events.extend(answered);
            match reached {
                Some(sequence) if sequence < from => {
                    return Err(format!(
                        "Archivist replay answer from {from} ends at {sequence}, before it"
                    ));
                }
                Some(sequence) if sequence < last => from = sequence + 1,
                _ => return Ok(events),
            }
        }
    }

    /// One answer of the Archivist's to a read of a resource's stream from
    /// `from`: its events, and the sequence number of the stream's last.
    async fn events_from(&self, resource_id: &str, from: u64) -> Result<(Vec<Value>, u64), String> {
        let authorization = self
            .token
            .authorization()
            .await
            .map_err(|error| error.to_string())?;
        let url = format!(
            "{}{}?fromSequence={from}",
            self.base,
            path("/events/{resourceId}", resource_id)
        );
        let response = in_client_span(
            "events.replay",
            self.waits
                .answer(self.reads.get(url).header("authorization", authorization)),
        )
        .await
        .map_err(|error| format!("Archivist replay read failed: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("Archivist replay read failed: {}", status.as_u16()));
        }
        let mut answer = self
            .waits
            .json(response)
            .await
            .map_err(|error| format!("Archivist replay answer is not JSON: {error}"))?;
        if let Some(problems) = semiont_core::spec::problems("ArchivistEventsResponse", &answer) {
            return Err(format!(
                "Archivist replay answer is not an ArchivistEventsResponse: {problems}"
            ));
        }
        let (Value::Array(events), Some(last)) =
            (answer["events"].take(), answer["lastSequence"].as_u64())
        else {
            return Err("Archivist replay answer holds no events or no lastSequence".to_owned());
        };
        Ok((events, last))
    }
}

/// The reads client and the gateway's waits for the Archivist's answers, on
/// tokio's paused clock. A stand-in for the client's connector counts each
/// attempt to connect, and makes it late, or makes none: an address that
/// takes no connection cannot be staged on the loopback, but reqwest's own
/// connect timeout over a connector that never answers ends an attempt
/// exactly as it ends one to such an address. A connection that is made goes
/// to a stand-in Archivist on the loopback.
#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::pin::{Pin, pin};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::Context;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::time::{Instant, sleep};
    use tower::ServiceExt;

    const HOST: &str = "archivist.test";

    /// What becomes of an attempt to connect.
    #[derive(Clone, Copy)]
    enum Connecting {
        /// The connection is never taken.
        NeverTaken,
        /// The connection is refused at once.
        Refused,
        /// The connection is made, this long after it is asked for.
        Taken { after: Duration },
    }

    /// Counts each attempt to connect.
    #[derive(Clone)]
    struct Attempts {
        made: Arc<AtomicUsize>,
        connecting: Connecting,
    }

    #[derive(Clone)]
    struct Attempt<S> {
        attempts: Attempts,
        connector: S,
    }

    impl<S> tower::Layer<S> for Attempts {
        type Service = Attempt<S>;

        fn layer(&self, connector: S) -> Attempt<S> {
            Attempt {
                attempts: self.clone(),
                connector,
            }
        }
    }

    impl<S, R> tower::Service<R> for Attempt<S>
    where
        S: tower::Service<R> + Clone + Send + 'static,
        S::Future: Send,
        S::Response: Send + 'static,
        S::Error: From<io::Error> + Send + 'static,
        R: Send + 'static,
    {
        type Response = S::Response;
        type Error = S::Error;
        type Future = Pin<Box<dyn Future<Output = Result<S::Response, S::Error>> + Send>>;

        fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), S::Error>> {
            Poll::Ready(Ok(()))
        }

        fn call(&mut self, request: R) -> Self::Future {
            self.attempts.made.fetch_add(1, Ordering::SeqCst);
            match self.attempts.connecting {
                Connecting::NeverTaken => Box::pin(std::future::pending()),
                Connecting::Refused => {
                    let refused = io::Error::from(io::ErrorKind::ConnectionRefused);
                    Box::pin(std::future::ready(Err(refused.into())))
                }
                Connecting::Taken { after } => {
                    let connector = self.connector.clone();
                    Box::pin(async move {
                        sleep(after).await;
                        connector.oneshot(request).await
                    })
                }
            }
        }
    }

    /// The reads client of the Archivist at `host`, its connections made
    /// through `attempts`.
    fn reads(host: &str, attempts: Attempts) -> reqwest::Client {
        // Already installed by another test of this process: one is enough.
        let _ = rustls::crypto::ring::default_provider().install_default();
        reads_client(host, Waits::stated().unwrap())
            .connector_layer(attempts)
            .build()
            .unwrap()
    }

    /// A read on the reads client, with the Archivist's waits: how it failed,
    /// and how many attempts it made.
    async fn read(connecting: Connecting) -> (reqwest::Error, usize) {
        let made = Arc::new(AtomicUsize::new(0));
        let client = reads(
            HOST,
            Attempts {
                made: made.clone(),
                connecting,
            },
        );
        let failed = client
            .get(format!("http://{HOST}/health"))
            .send()
            .await
            .unwrap_err();
        (failed, made.load(Ordering::SeqCst))
    }

    #[tokio::test(start_paused = true)]
    async fn a_read_whose_connection_is_not_taken_in_time_is_not_sent_again() {
        let (failed, attempts) = read(Connecting::NeverTaken).await;
        assert!(failed.is_connect() && failed.is_timeout(), "{failed:?}");
        assert_eq!(attempts, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_read_whose_connection_is_refused_is_sent_once_more() {
        let (failed, attempts) = read(Connecting::Refused).await;
        assert!(failed.is_connect() && !failed.is_timeout(), "{failed:?}");
        assert_eq!(attempts, 2);
    }

    /// The clock of a test that waits out long times over real sockets.
    ///
    /// A paused clock alone will not do. It runs ahead to the next timer
    /// whenever nothing is runnable, and a connection or an answer that is on
    /// its way is not runnable: a wait for it would end before it could
    /// arrive. So the clock is held still, which the runtime does while a
    /// blocking task runs, and moved by hand, `STEP` for each real
    /// millisecond.
    struct QuickClock(tokio::task::JoinHandle<()>);

    const STEP: Duration = Duration::from_millis(250);

    impl QuickClock {
        fn start() -> QuickClock {
            QuickClock(tokio::spawn(async {
                loop {
                    let _ = tokio::task::spawn_blocking(|| {
                        std::thread::sleep(Duration::from_millis(1));
                    })
                    .await;
                    tokio::time::advance(STEP).await;
                }
            }))
        }
    }

    impl Drop for QuickClock {
        fn drop(&mut self) {
            self.0.abort();
        }
    }

    /// Whether `elapsed` is `expected`: no less, and no more than the quick
    /// clock moves while the sockets carry what they carry.
    fn took(elapsed: Duration, expected: Duration) -> bool {
        elapsed >= expected && elapsed < expected + Duration::from_secs(2)
    }

    /// `work`, which must end within twice the longest wait for an answer to
    /// begin: a wait that never ends fails the test instead of hanging it.
    async fn guarded<T>(work: impl Future<Output = T>) -> T {
        let waits = Waits::stated().unwrap();
        tokio::time::timeout((waits.connect + waits.read) * 2, work)
            .await
            .expect("it ended")
    }

    /// The longest the Archivist holds a read of anchored text.
    fn settle_wait() -> Duration {
        spec().archivist["paths"]["/resources/{id}/anchored-text"]["get"]["x-semiont-limits"]
            ["settleWaitSeconds"]
            .as_u64()
            .map(Duration::from_secs)
            .unwrap()
    }

    /// What the stand-in Archivist does on a connection, once a read has come
    /// whole on it.
    enum Answering {
        /// Begins its answer this long after, and sends it whole.
        After(Duration),
        /// Closes the connection this long after, having answered nothing.
        Closes(Duration),
        /// Never answers.
        Never,
        /// Sends its answer's head and first part at once, and no more.
        Stalls,
    }

    /// A stand-in Archivist on the loopback, which answers the connections
    /// made to it, in the order they are made, as `answering` says; and the
    /// URL of a read of it.
    async fn archivist(answering: Vec<Answering>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for answering in answering {
                let (connection, _) = listener.accept().await.unwrap();
                tokio::spawn(answer(connection, answering));
            }
        });
        format!("http://{address}/health")
    }

    async fn answer(mut connection: TcpStream, answering: Answering) {
        let mut read = Vec::new();
        let mut chunk = [0u8; 1024];
        while !read.ends_with(b"\r\n\r\n") {
            let got = connection.read(&mut chunk).await.unwrap();
            assert_ne!(got, 0, "closed before its read came whole");
            read.extend_from_slice(&chunk[..got]);
        }
        match answering {
            Answering::After(wait) => {
                sleep(wait).await;
                connection
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}")
                    .await
                    .unwrap();
            }
            Answering::Closes(wait) => {
                sleep(wait).await;
                return;
            }
            Answering::Never => {}
            Answering::Stalls => {
                connection
                    .write_all(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n1\r\n{\r\n")
                    .await
                    .unwrap();
            }
        }
        std::future::pending::<()>().await;
    }

    /// A read of `url` on the reads client, whose answer is waited for as the
    /// gateway waits.
    async fn answered(
        url: &str,
        connecting: Connecting,
    ) -> (Result<reqwest::Response, String>, usize) {
        let made = Arc::new(AtomicUsize::new(0));
        let client = reads(
            "127.0.0.1",
            Attempts {
                made: made.clone(),
                connecting,
            },
        );
        let answer = guarded(Waits::stated().unwrap().answer(client.get(url))).await;
        (answer, made.load(Ordering::SeqCst))
    }

    #[tokio::test(start_paused = true)]
    async fn a_read_whose_answer_begins_after_read_seconds_and_within_connect_and_read_seconds_is_answered()
     {
        let _clock = QuickClock::start();
        let waits = Waits::stated().unwrap();
        let connecting = waits.connect - Duration::from_secs(1);
        let held = settle_wait() + Duration::from_secs(2);
        let begins = connecting + held;
        assert!(
            begins > waits.read && begins < waits.connect + waits.read,
            "an answer that begins {begins:?} after its read is sent tells nothing of the waits"
        );
        let url = archivist(vec![Answering::After(held)]).await;
        let sent = Instant::now();
        let (answer, attempts) = answered(&url, Connecting::Taken { after: connecting }).await;
        let elapsed = sent.elapsed();
        let answer = answer.unwrap();
        assert_eq!(answer.status(), reqwest::StatusCode::OK);
        assert!(
            took(elapsed, begins),
            "answered after {elapsed:?}, not {begins:?}"
        );
        assert_eq!(attempts, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_read_whose_first_attempt_breaks_late_and_whose_second_hangs_gives_up_connect_and_read_seconds_after_its_first_send()
     {
        let _clock = QuickClock::start();
        let waits = Waits::stated().unwrap();
        let breaks = waits.read - Duration::from_secs(2);
        let url = archivist(vec![Answering::Closes(breaks), Answering::Never]).await;
        let sent = Instant::now();
        let (answer, attempts) = answered(
            &url,
            Connecting::Taken {
                after: Duration::ZERO,
            },
        )
        .await;
        let elapsed = sent.elapsed();
        let given_up = waits.connect + waits.read;
        assert!(answer.is_err(), "{answer:?}");
        assert!(
            took(elapsed, given_up),
            "gave up after {elapsed:?}, not {given_up:?}"
        );
        assert_eq!(attempts, 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_part_that_does_not_come_within_read_seconds_ends_the_answer_as_a_stall() {
        let _clock = QuickClock::start();
        let waits = Waits::stated().unwrap();
        let url = archivist(vec![Answering::Stalls]).await;
        let (answer, _) = answered(
            &url,
            Connecting::Taken {
                after: Duration::ZERO,
            },
        )
        .await;
        let mut parts = pin!(waits.parts(answer.unwrap()));
        let first = guarded(parts.next()).await;
        assert_eq!(first, Some(Ok(Bytes::from_static(b"{"))));
        let asked = Instant::now();
        let stalled = guarded(parts.next()).await;
        let elapsed = asked.elapsed();
        assert!(matches!(stalled, Some(Err(_))), "{stalled:?}");
        assert!(
            took(elapsed, waits.read),
            "stalled after {elapsed:?}, not {:?}",
            waits.read
        );
        assert_eq!(guarded(parts.next()).await, None);
    }
}
