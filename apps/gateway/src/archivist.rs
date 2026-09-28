//! The gateway's calls onto the Archivist's HTTP surface
//! (specs/src/archivist/openapi.json): an upload is stored and recorded there,
//! bytes and a resource's JSON-LD description are read back, and a scope's
//! persisted events are read for a replay. The gateway parses none of it; it
//! forwards, and maps the answer onto its own responses. It reaches the
//! Archivist as itself, with a token from the issuer's client-credentials
//! grant.

use crate::http::ApiError;
use crate::identity::encode_uri_component;
use crate::logging;
use crate::spec::{Spec, spec};
use crate::telemetry;
use axum::body::Body;
use axum::http::StatusCode;
use opentelemetry::KeyValue;
use opentelemetry::trace::SpanKind;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// The Archivist operations the gateway calls. The embedded Archivist
/// document must declare each, or the gateway does not start.
const CALLS: [(&str, &str); 4] = [
    ("POST", "/resources"),
    ("GET", "/resources/{id}/content"),
    ("GET", "/resources/{id}/jsonld"),
    ("GET", "/events/{resourceId}"),
];

/// Renew a service token this long before it expires.
const RENEW_BEFORE_EXPIRY: Duration = Duration::from_secs(30);

pub struct Credential {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
}

pub struct Archivist {
    base: String,
    http: reqwest::Client,
    credential: Credential,
    token_endpoint: Mutex<Option<String>>,
    token: Mutex<Option<(String, Instant)>>,
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
    telemetry::in_span(
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
            base: format!("http://{host}:{port}"),
            http,
            credential,
            token_endpoint: Mutex::new(None),
            token: Mutex::new(None),
        }
    }

    async fn token_endpoint(&self) -> Result<String, String> {
        let mut known = self.token_endpoint.lock().await;
        if let Some(endpoint) = known.as_ref() {
            return Ok(endpoint.clone());
        }
        let issuer = &self.credential.issuer;
        let base = if issuer.ends_with('/') {
            issuer.clone()
        } else {
            format!("{issuer}/")
        };
        let url = format!("{base}.well-known/openid-configuration");
        let response = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("OIDC discovery for {issuer} failed: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "OIDC discovery for {issuer} failed: HTTP {} from {url}",
                response.status().as_u16()
            ));
        }
        let document: Value = response
            .json()
            .await
            .map_err(|e| format!("OIDC discovery for {issuer} is not JSON: {e}"))?;
        let endpoint = document["token_endpoint"]
            .as_str()
            .ok_or_else(|| format!("OIDC discovery for {issuer} returned no `token_endpoint`"))?;
        *known = Some(endpoint.to_owned());
        Ok(endpoint.to_owned())
    }

    /// This gateway's own token, renewed before it expires. The grant's
    /// `expires_in` says how long it lives; without one it is not kept.
    async fn authorization(&self) -> Result<String, String> {
        let mut held = self.token.lock().await;
        if let Some((token, expires)) = held.as_ref()
            && Instant::now() + RENEW_BEFORE_EXPIRY < *expires
        {
            return Ok(format!("Bearer {token}"));
        }
        let endpoint = self.token_endpoint().await?;
        let Credential {
            issuer,
            client_id,
            client_secret,
        } = &self.credential;
        let form = format!(
            "grant_type=client_credentials&client_id={}&client_secret={}",
            encode_uri_component(client_id),
            encode_uri_component(client_secret)
        );
        let response = self
            .http
            .post(&endpoint)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await
            .map_err(|e| {
                format!("Client-credentials grant for {client_id} at {issuer} failed: {e}")
            })?;
        if !response.status().is_success() {
            // The status, never the body: an error body can echo the secret.
            return Err(format!(
                "Client-credentials grant for {client_id} at {issuer} failed (HTTP {})",
                response.status().as_u16()
            ));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|e| format!("Token endpoint for {issuer} did not answer JSON: {e}"))?;
        let token = body["access_token"]
            .as_str()
            .ok_or_else(|| format!("Token endpoint for {issuer} returned no `access_token`"))?
            .to_owned();
        *held = body["expires_in"]
            .as_f64()
            .filter(|s| s.is_finite())
            .map(|seconds| {
                (
                    token.clone(),
                    Instant::now() + Duration::from_secs_f64(seconds.max(0.0)),
                )
            });
        Ok(format!("Bearer {token}"))
    }

    async fn authorized(&self, operation: &str) -> Result<String, ApiError> {
        self.authorization().await.map_err(|error| {
            logging::error(
                "The gateway could not obtain its own token for the Archivist",
                client(json!({ "operation": operation, "error": error })),
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
    ) -> Result<String, ApiError> {
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
        if status.is_success()
            && let Some(id) = answer.as_ref().and_then(|a| a["resourceId"].as_str())
        {
            return Ok(id.to_owned());
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
    pub async fn describe(&self, resource_id: &str) -> Result<Option<Value>, ApiError> {
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

    /// A representation's bytes, streamed as they arrive, and their media
    /// type. The 404's `code` says which half of the lookup failed.
    pub async fn content(&self, resource_id: &str) -> Result<(Body, String), ApiError> {
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

    /// A resource's persisted events from `from_sequence`, inclusive. An
    /// answer that is not the ArchivistEventsResponse the spec declares is a
    /// failure: read on trust, it would drop an event it could not route.
    pub async fn replay(
        &self,
        resource_id: &str,
        from_sequence: u64,
    ) -> Result<Vec<Value>, String> {
        let authorization = self.authorization().await?;
        let url = format!(
            "{}{}?fromSequence={from_sequence}",
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
        let answer: Value = response
            .json()
            .await
            .map_err(|e| format!("Archivist replay answer is not JSON: {e}"))?;
        if let Some(problems) = crate::spec::problems("ArchivistEventsResponse", &answer) {
            return Err(format!(
                "Archivist replay answer is not an ArchivistEventsResponse: {problems}"
            ));
        }
        Ok(answer["events"].as_array().cloned().unwrap_or_default())
    }
}
