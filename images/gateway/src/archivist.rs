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
use futures::StreamExt;
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
    /// The reads: each part of an answer waited for `read`, and a read that
    /// got no answer sent once more.
    reads: reqwest::Client,
    /// The uploads: an answer waited for `read` from the upload's last byte.
    uploads: reqwest::Client,
    read: Duration,
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
/// states it (`x-semiont-limits`): `connectSeconds` for a connection, and
/// `readSeconds` for each part of an answer.
fn waits() -> Result<(Duration, Duration), String> {
    let limit = |key: &str| {
        spec().archivist["x-semiont-limits"][key]
            .as_u64()
            .map(Duration::from_secs)
            .ok_or_else(|| format!("The Archivist's document states no x-semiont-limits.{key}"))
    };
    Ok((limit("connectSeconds")?, limit("readSeconds")?))
}

/// The retry policy of the client the gateway reads from the Archivist with:
/// a read that got no answer — its connection could not be made, or broke or
/// closed before a response came back, as a pooled connection the Archivist
/// closes just as a read is written to it does — is sent once more. An answer
/// is never asked again, whatever its status. A read whose answer did not
/// come within its wait is not sent again either: reqwest keeps that timer
/// outside the policy.
fn read_retry(host: &str) -> reqwest::retry::Builder {
    reqwest::retry::for_host(host.to_owned())
        .max_retries_per_request(1)
        // With one retry a read, the most retries can add is a second read
        // to a store that is not answering; a budget would only take some
        // reads' one retry away.
        .no_budget()
        .classify_fn(|attempt| {
            if attempt.status().is_none() {
                attempt.retryable()
            } else {
                attempt.success()
            }
        })
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
        let (connect, read) = waits()?;
        let built = |builder: reqwest::ClientBuilder| {
            builder
                .build()
                .map_err(|e| format!("cannot build the Archivist's HTTP client: {e}"))
        };
        Ok(Archivist {
            base: origin(host, port),
            reads: built(
                reqwest::Client::builder()
                    .retry(read_retry(host))
                    .connect_timeout(connect)
                    .read_timeout(read),
            )?,
            uploads: built(reqwest::Client::builder().connect_timeout(connect))?,
            read,
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
    /// gateway verified; answer the id the Archivist recorded it under. Its
    /// 400 and 500 come back with its message; anything else is a 503.
    pub async fn record_upload(
        &self,
        body: Body,
        content_type: &str,
        principal: &str,
        roles: &[String],
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
            .body(reqwest::Body::wrap_stream(upload));
        if !roles.is_empty() {
            request = request.header("semiont-roles", roles.join(","));
        }
        let read = self.read;
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
        if (status == StatusCode::BAD_REQUEST || status == StatusCode::INTERNAL_SERVER_ERROR)
            && let Some(message) = answer.as_ref().and_then(|a| a["error"].as_str())
        {
            return Err(ApiError::new(status, message));
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
        let response = in_client_span("resources.describe", request.send())
            .await
            .map_err(|e| {
                logging::error(
                    "Archivist unreachable for a description",
                    client(json!({ "resourceId": resource_id, "error": logging::chain(&e) })),
                );
                unavailable()
            })?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(None),
            status if status.is_success() => {
                response.json::<Value>().await.map(Some).map_err(|e| {
                    logging::error(
                        "Archivist description is not JSON",
                        client(json!({ "resourceId": resource_id, "error": logging::chain(&e) })),
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
        let response = in_client_span("resources.annotations", request.send())
            .await
            .map_err(|e| {
                logging::error(
                    "Archivist unreachable for a resource's annotations",
                    client(json!({ "resourceId": resource_id, "error": logging::chain(&e) })),
                );
                unavailable()
            })?;
        match response.status() {
            StatusCode::OK => Ok(Some(Body::from_stream(response.bytes_stream()))),
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
        let response = in_client_span("resources.anchored_text", request.send())
            .await
            .map_err(|e| {
                logging::error(
                    "Archivist unreachable for an anchored text",
                    client(json!({ "resourceId": resource_id, "error": logging::chain(&e) })),
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
        Ok(Body::from_stream(response.bytes_stream()))
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
        let response = in_client_span("content.get", request.send())
            .await
            .map_err(|e| {
                logging::error(
                    "Archivist content read unreachable",
                    client(json!({ "resourceId": resource_id, "error": logging::chain(&e) })),
                );
                unavailable()
            })?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            let answer: Value = response.json().await.unwrap_or(Value::Null);
            if spec().validator("RepresentationNotFound").is_valid(&answer) {
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
        Ok((Body::from_stream(response.bytes_stream()), media_type))
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
            self.reads
                .get(url)
                .header("authorization", authorization)
                .send(),
        )
        .await
        .map_err(|e| format!("Archivist replay read failed: {}", logging::chain(&e)))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("Archivist replay read failed: {}", status.as_u16()));
        }
        let mut answer: Value = response
            .json()
            .await
            .map_err(|e| format!("Archivist replay answer is not JSON: {e}"))?;
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
