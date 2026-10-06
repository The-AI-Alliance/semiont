//! The Archivist's HTTP surface: its health, a stream's stored events, a
//! resource's content and description, and the upload that stores content
//! and records it.

use crate::archivist::{Archivist, Refusal, primary_representation, text};
use crate::{browse, commands};
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use semiont::media_types::{base_media_type, capabilities_of};
use semiont::roles::{SERVICE_ROLE, has_role};
use semiont_archivist_record::{Object, ids};
use semiont_http_service::{IssuerVerifier, bearer_token};
use semiont_observability::logging;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::AsyncReadExt;

pub struct Surface {
    pub archivist: Arc<Archivist>,
    pub verifier: IssuerVerifier,
}

type Shared = State<Arc<Surface>>;

fn json_reply(status: StatusCode, body: Value) -> Response {
    let mut response = (status, body.to_string()).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

fn error(status: StatusCode, message: &str) -> Response {
    json_reply(status, json!({ "error": message }))
}

/// The refusal of a caller that is not a service of this knowledge base: a
/// token of its issuer, for its audience, carrying the service role, is
/// admitted, and anything else is refused alike.
async fn refusal(surface: &Surface, headers: &HeaderMap) -> Option<Response> {
    let presented = bearer_token(headers);
    let admitted = match &presented {
        Some(token) => surface
            .verifier
            .verify(token)
            .await
            .is_ok_and(|claims| has_role(&claims, SERVICE_ROLE)),
        None => false,
    };
    if admitted {
        return None;
    }
    let mut refusal = error(StatusCode::UNAUTHORIZED, "unauthorized");
    refusal.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static(if presented.is_some() {
            "Bearer error=\"invalid_token\""
        } else {
            "Bearer"
        }),
    );
    Some(refusal)
}

async fn health() -> Response {
    json_reply(
        StatusCode::OK,
        json!({ "status": "ok", "actors": ["stower", "browser", "cloneTokenManager"] }),
    )
}

async fn not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

async fn events(
    State(surface): Shared,
    Path(resource_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(refusal) = refusal(&surface, &headers).await {
        return refusal;
    }
    let from = query
        .get("fromSequence")
        .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|n| n.parse::<u64>().ok())
        .filter(|n| *n >= 1);
    let (Some(from), true) = (from, ids::is_safe(&resource_id)) else {
        return error(
            StatusCode::BAD_REQUEST,
            "resourceId path segment and integer fromSequence >= 1 are required",
        );
    };
    match surface.archivist.events(&resource_id) {
        Ok(events) => {
            let from_there: Vec<Object> = events
                .into_iter()
                .filter(|e| {
                    e["metadata"]["sequenceNumber"]
                        .as_u64()
                        .is_some_and(|n| n >= from)
                })
                .collect();
            json_reply(StatusCode::OK, json!({ "events": from_there }))
        }
        Err(refusal) => {
            logging::error(
                "Event read failed",
                json!({ "component": "archivist", "resourceId": resource_id, "error": refusal.message }),
            );
            error(StatusCode::INTERNAL_SERVER_ERROR, "event read failed")
        }
    }
}

async fn content(
    State(surface): Shared,
    Path(resource_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Some(refusal) = refusal(&surface, &headers).await {
        return refusal;
    }
    let view = match ids::is_safe(&resource_id) {
        true => surface.archivist.held_view(&resource_id).ok().flatten(),
        false => None,
    };
    let Some(view) = view else {
        return json_reply(
            StatusCode::NOT_FOUND,
            json!({ "error": format!("Resource not found: {resource_id}"), "code": "resource" }),
        );
    };
    let representation = primary_representation(&view);
    let Some(uri) = representation.and_then(|r| text(r, "storageUri")) else {
        return json_reply(
            StatusCode::NOT_FOUND,
            json!({ "error": format!("Resource representation not found: no storageUri for {resource_id}"), "code": "representation" }),
        );
    };
    let media_type = representation
        .and_then(|r| text(r, "mediaType"))
        .unwrap_or("application/octet-stream");
    let opened = match surface.archivist.content.resolve(uri) {
        Ok(path) => tokio::fs::File::open(path).await.map_err(|e| e.to_string()),
        Err(refused) => Err(refused),
    };
    let file = match opened {
        Ok(file) => file,
        Err(why) => {
            logging::error(
                "Content read failed",
                json!({ "component": "archivist", "resourceId": resource_id, "error": why }),
            );
            return error(StatusCode::INTERNAL_SERVER_ERROR, "content read failed");
        }
    };
    let chunks = futures::stream::unfold(file, |mut file| async move {
        let mut chunk = vec![0u8; 64 * 1024];
        match file.read(&mut chunk).await {
            Ok(0) => None,
            Ok(read) => {
                chunk.truncate(read);
                Some((Ok::<Bytes, std::io::Error>(Bytes::from(chunk)), file))
            }
            Err(error) => Some((Err(error), file)),
        }
    });
    let mut response = Body::from_stream(chunks).into_response();
    if let Ok(value) = HeaderValue::from_str(media_type) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response
}

async fn described(
    State(surface): Shared,
    Path(resource_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Some(refusal) = refusal(&surface, &headers).await {
        return refusal;
    }
    let graph = match ids::is_safe(&resource_id) {
        true => browse::resource_graph(&surface.archivist, &resource_id),
        false => Ok(None),
    };
    match graph {
        Ok(Some(graph)) => {
            let mut response = (StatusCode::OK, graph.to_string()).into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/ld+json; charset=utf-8"),
            );
            response
        }
        Ok(None) => error(StatusCode::NOT_FOUND, "Resource not found"),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    }
}

fn bad(message: impl AsRef<str>) -> Response {
    error(StatusCode::BAD_REQUEST, message.as_ref())
}

/// The command an upload's fields make: a copy when they carry a clone
/// token, a new resource otherwise.
fn recording(
    fields: &HashMap<String, String>,
    principal: &str,
    roles: Vec<String>,
) -> Result<(bool, Object), &'static str> {
    let mut command = Object::new();
    for key in ["name", "storageUri", "format"] {
        command.insert(key.into(), json!(fields[key]));
    }
    command.insert("_userId".into(), json!(principal));
    if let Some(token) = fields.get("cloneToken") {
        command.insert("token".into(), json!(token));
        if let Some(archive) = fields.get("archiveOriginal") {
            command.insert("archiveOriginal".into(), json!(archive == "true"));
        }
        return Ok((true, command));
    }
    if !roles.is_empty() {
        command.insert("_roles".into(), json!(roles));
    }
    for key in ["language", "generationPrompt", "jobId"] {
        if let Some(value) = fields.get(key) {
            command.insert(key.into(), json!(value));
        }
    }
    if let Some(types) = fields.get("entityTypes") {
        let Ok(parsed) = serde_json::from_str::<Value>(types) else {
            return Err("entityTypes is not JSON");
        };
        if !parsed
            .as_array()
            .is_some_and(|names| names.iter().all(Value::is_string))
        {
            return Err("entityTypes is not a JSON array of names");
        }
        command.insert("entityTypes".into(), parsed);
    }
    if let Some(generator) = fields.get("generator") {
        let Ok(parsed) = serde_json::from_str::<Value>(generator) else {
            return Err("generator is not JSON");
        };
        if semiont_core::spec::problems("Agent", &parsed).is_some() {
            return Err("generator is not an Agent");
        }
        command.insert("generator".into(), parsed);
    }
    let mut source = Object::new();
    for (field, key) in [
        ("sourceResourceId", "resourceId"),
        ("sourceAnnotationId", "annotationId"),
    ] {
        if let Some(value) = fields.get(field) {
            source.insert(key.into(), json!(value));
        }
    }
    if !source.is_empty() {
        command.insert("generatedFrom".into(), Value::Object(source));
    }
    if let Some(draft) = fields.get("isDraft") {
        command.insert("isDraft".into(), json!(draft == "true"));
    }
    Ok((false, command))
}

async fn upload(State(surface): Shared, request: Request) -> Response {
    // The whole body is taken before anything is answered: a caller still
    // sending when the answer closes the connection reads no answer.
    let (parts, body) = request.into_parts();
    let Ok(body) = axum::body::to_bytes(body, usize::MAX).await else {
        return bad("The body is not multipart/form-data");
    };
    let headers = parts.headers.clone();
    let request = Request::from_parts(parts, Body::from(body));
    if let Some(refusal) = refusal(&surface, &headers).await {
        return refusal;
    }
    let header_text = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let principal = header_text("semiont-principal");
    if principal.is_empty() {
        return bad(
            "Semiont-Principal is required: the record attributes every resource to someone",
        );
    }
    let roles: Vec<String> = header_text("semiont-roles")
        .split(',')
        .map(str::trim)
        .filter(|role| !role.is_empty())
        .map(str::to_owned)
        .collect();

    let Ok(mut form) = Multipart::from_request(request, &()).await else {
        return bad("The body is not multipart/form-data");
    };
    let mut fields: HashMap<String, String> = HashMap::new();
    let mut file: Option<Bytes> = None;
    loop {
        let field = match form.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => return bad("The body is not multipart/form-data"),
        };
        let name = field.name().unwrap_or_default().to_owned();
        let is_file = field.file_name().is_some();
        let Ok(bytes) = field.bytes().await else {
            return bad("The body is not multipart/form-data");
        };
        if name == "file" && is_file {
            file = Some(bytes);
        } else if !bytes.is_empty() {
            fields.insert(name, String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    let missing: Vec<&str> = ["name", "format", "storageUri"]
        .into_iter()
        .filter(|key| !fields.contains_key(*key))
        .chain(file.is_none().then_some("file"))
        .collect();
    if !missing.is_empty() {
        return bad(format!(
            "root: missing required property {}",
            missing.join(", ")
        ));
    }
    let file = file.unwrap_or_default();
    let base = base_media_type(&fields["format"]);
    if capabilities_of(&base).is_none() {
        return bad(format!("Unsupported media type: {base}"));
    }
    let (is_clone, mut command) = match recording(&fields, &principal, roles) {
        Ok(recording) => recording,
        Err(why) => return bad(why),
    };

    let archivist = &surface.archivist;
    let recorded: Result<Value, Refusal> = async {
        let held = archivist
            .content
            .store(&fields["storageUri"], &file)
            .await?;
        command.insert("contentChecksum".into(), json!(held.checksum));
        command.insert("byteSize".into(), json!(held.byte_size));
        match is_clone {
            true => commands::clone_create(archivist, &command).await,
            false => commands::yield_create(archivist, &command).await,
        }
    }
    .await;
    match recorded {
        Ok(response) => json_reply(
            StatusCode::OK,
            json!({ "resourceId": response["resourceId"] }),
        ),
        Err(refusal) => {
            logging::warn(
                "Upload not recorded",
                json!({ "component": "archivist", "error": refusal.message }),
            );
            error(StatusCode::INTERNAL_SERVER_ERROR, &refusal.message)
        }
    }
}

pub fn router(surface: Arc<Surface>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/events/{resourceId}", get(events))
        .route("/resources", post(upload))
        .route("/resources/{id}/content", get(content))
        .route("/resources/{id}/jsonld", get(described))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(DefaultBodyLimit::disable())
        .with_state(surface)
}
