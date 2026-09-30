//! Bytes in and out, through the Archivist: an upload is forwarded to it
//! whole; the pipe serves a representation's bytes verbatim, never
//! negotiated or transcoded; the JSON-LD description is its answer.

use crate::app::App;
use crate::http::{ApiError, Authenticated, MediaOrBearer, json_response};
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use opentelemetry::KeyValue;
use opentelemetry::trace::SpanKind;
use semiont::types::CreateResourceResponse;
use semiont_core::bus_log::bus_log;
use semiont_core::logging;
use semiont_core::telemetry;
use serde_json::json;
use std::sync::Arc;

fn caller_trace(headers: &HeaderMap) -> opentelemetry::Context {
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    telemetry::continued(get("traceparent"), get("tracestate"))
}

/// `POST /resources`: the multipart body goes to the Archivist untouched,
/// naming the uploader; 202 with the id it recorded. A recorded upload is a
/// write, so a person making it is named on the record.
pub async fn upload(
    State(app): State<Arc<App>>,
    Authenticated(principal): Authenticated,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let roles = principal.roles.clone().unwrap_or_default();
    let resource_id = telemetry::in_span(
        "content.put.server".to_owned(),
        SpanKind::Server,
        Vec::new(),
        caller_trace(&headers),
        app.archivist
            .record_upload(body, &content_type, &principal.did, &roles),
    )
    .await?;
    if let Err(unavailable) = crate::routes::bus::publish_profile(&app, &principal).await {
        logging::warn(
            "[bus PROFILE-DROPPED] the signal plane could not carry an uploader's name",
            json!({ "component": "bus", "did": principal.did, "error": unavailable.to_string() }),
        );
    }
    Ok(json_response(
        StatusCode::ACCEPTED,
        &CreateResourceResponse { resource_id },
    ))
}

async fn bytes_of(
    app: &App,
    id: &str,
    headers: &HeaderMap,
    cache_control: &'static str,
) -> Result<Response, ApiError> {
    bus_log("GET", "content", &json!({ "resourceId": id }), None, None);
    let (body, media_type) = telemetry::in_span(
        "content.get.server".to_owned(),
        SpanKind::Server,
        vec![KeyValue::new("resource.id", id.to_owned())],
        caller_trace(headers),
        app.archivist.content(id),
    )
    .await?;
    let mut response = Response::new(body);
    let out = response.headers_mut();
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&media_type)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    out.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    if let Ok(link) = HeaderValue::from_str(&format!(
        "</resources/{id}/jsonld>; rel=\"describedby\"; type=\"application/ld+json\""
    )) {
        out.insert(header::LINK, link);
    }
    Ok(response)
}

/// `GET /resources/{id}`: the stored bytes, private to the bearer's caches.
pub async fn pipe(
    State(app): State<Arc<App>>,
    Authenticated(_): Authenticated,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    bytes_of(&app, &id, &headers, "private, max-age=31536000, immutable").await
}

/// `GET /api/resources/{id}`: the same bytes, to a bearer or to the
/// resource's media token; public, since the token is part of the URL.
pub async fn media_pipe(
    State(app): State<Arc<App>>,
    _access: MediaOrBearer,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    bytes_of(&app, &id, &headers, "public, max-age=31536000, immutable").await
}

/// `GET /resources/{id}/jsonld`: the Archivist's JSON-LD description. Live data: never cached.
pub async fn description(
    State(app): State<Arc<App>>,
    Authenticated(_): Authenticated,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    use opentelemetry::context::FutureExt;
    let described = app
        .archivist
        .describe(&id)
        .with_context(caller_trace(&headers))
        .await?;
    let Some(description) = described else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Resource not found"));
    };
    let mut response = json_response(StatusCode::OK, &description);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/ld+json; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    Ok(response)
}
