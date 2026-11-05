//! The gateway's calls onto the Archivist's HTTP surface
//! (protocol/specs/src/archivist/openapi.json): an upload is stored and recorded there,
//! bytes, a resource's JSON-LD description, its annotations and its anchored text are read
//! back, and a scope's persisted events are read for a replay. The gateway
//! parses none of it; it forwards, and maps the answer onto its own
//! responses. It reaches the Archivist as itself, with its service account's
//! token.

use crate::http::ApiError;
use axum::body::Body;
use axum::http::{StatusCode, Uri};
use opentelemetry::KeyValue;
use opentelemetry::trace::SpanKind;
use semiont::identity::encode_uri_component;
use semiont::types::ResourceId;
use semiont_core::spec::{Spec, spec};
use semiont_http_transport::service_account::{Credential, ServiceToken};
use semiont_observability::logging;
use serde_json::{Value, json};

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
    http: reqwest::Client,
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

/// The retry policy of the client the gateway reaches the Archivist with: a
/// read that got no answer — its connection could not be made, or broke or
/// closed before a response came back, as a pooled connection the Archivist
/// closes just as a read is written to it does — is sent once more. An answer
/// is never asked again, whatever its status, and an upload is never sent
/// again: its body is streamed, and a streamed body cannot be sent twice.
pub(crate) fn read_retry(host: &str, port: u16) -> Result<reqwest::retry::Builder, String> {
    let address = origin(host, port);
    let archivist = reqwest::Url::parse(&address)
        .map_err(|e| format!("The Archivist's address {address} is not a URL: {e}"))?;
    Ok(reqwest::retry::for_host(host.to_owned())
        .max_retries_per_request(1)
        // With one retry a read, the most retries can add is a second read
        // to a store that is not answering; a budget would only take some
        // reads' one retry away.
        .no_budget()
        .classify_fn(move |attempt| {
            // reqwest asks its scope only before a second retry, so the first
            // is refused here to every request but the Archivist's, port and
            // all: the issuer may be on the Archivist's host.
            if attempt.method() == reqwest::Method::GET
                && to_archivist(&archivist, attempt.uri())
                && attempt.status().is_none()
            {
                attempt.retryable()
            } else {
                attempt.success()
            }
        }))
}

/// Where the gateway's requests to the Archivist at `host` and `port` go.
fn origin(host: &str, port: u16) -> String {
    format!("http://{host}:{port}")
}

/// Whether a request to `uri` is one to `archivist`: the same host and port,
/// each read as the URL parser writes it, which drops a scheme's default port
/// and lowercases a host, as it did to the request's own URL.
fn to_archivist(archivist: &reqwest::Url, uri: &Uri) -> bool {
    reqwest::Url::parse(&uri.to_string()).is_ok_and(|url| {
        url.host_str() == archivist.host_str()
            && url.port_or_known_default() == archivist.port_or_known_default()
    })
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
    pub fn new(host: &str, port: u16, credential: Credential, http: reqwest::Client) -> Archivist {
        Archivist {
            base: origin(host, port),
            token: ServiceToken::new(credential, http.clone()),
            http,
        }
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
        let mut request = self
            .http
            .post(format!("{}/resources", self.base))
            .header("authorization", authorization)
            .header("content-type", content_type)
            .header("semiont-principal", principal)
            .body(reqwest::Body::wrap_stream(body.into_data_stream()));
        if !roles.is_empty() {
            request = request.header("semiont-roles", roles.join(","));
        }
        let response = in_client_span("resources.record", request.send())
            .await
            .map_err(|e| {
                logging::error(
                    "Archivist unreachable for an upload",
                    client(json!({ "error": logging::chain(&e) })),
                );
                unavailable()
            })?;
        let status = response.status();
        let answer: Option<Value> = response.json().await.ok();
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
            .http
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
            .http
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
            .http
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
            .http
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
            self.http
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The Archivist at `host` and `port`, as the retry policy reads it.
    fn archivist(host: &str, port: u16) -> reqwest::Url {
        reqwest::Url::parse(&origin(host, port)).unwrap()
    }

    /// The URI a request to `url` carries: reqwest parses the URL, then writes it as a URI.
    fn sent_to(url: &str) -> Uri {
        reqwest::Url::parse(url).unwrap().as_str().parse().unwrap()
    }

    /// The URI of a content read of the Archivist's at `host` and `port`.
    fn content_read(host: &str, port: u16) -> Uri {
        sent_to(&format!(
            "{}{}",
            origin(host, port),
            path("/resources/{id}/content", "res-1")
        ))
    }

    #[test]
    fn a_request_is_the_archivists_by_host_and_port_as_the_url_parser_writes_them() {
        assert!(
            to_archivist(&archivist("archivist", 80), &content_read("archivist", 80)),
            "port 80, written out in the configuration and dropped from the request"
        );
        assert!(to_archivist(
            &archivist("archivist", 9090),
            &content_read("archivist", 9090)
        ));
        assert!(
            to_archivist(
                &archivist("Archivist.Internal", 9090),
                &content_read("Archivist.Internal", 9090)
            ),
            "a host configured in capitals, lowercased in the request"
        );

        let on_loopback = archivist("127.0.0.1", 9090);
        assert!(
            !to_archivist(
                &on_loopback,
                &sent_to("http://127.0.0.1:8080/realms/semiont/protocol/openid-connect/certs")
            ),
            "the issuer, on the Archivist's host at a port of its own"
        );
        assert!(
            !to_archivist(
                &on_loopback,
                &sent_to("http://keycloak:9090/realms/semiont/protocol/openid-connect/certs")
            ),
            "another host"
        );
    }
}
