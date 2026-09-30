//! What the gateway says about itself, the knowledge base, and its caller.

use crate::app::App;
use crate::http::{Authenticated, json_response};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use semiont_core::spec::{VERSION, spec};
use serde_json::json;
use std::sync::Arc;

/// `GET /api/health`, and `GET /` — where a person who typed the host lands.
pub async fn health() -> Response {
    json_response(
        StatusCode::OK,
        &json!({
            "status": "operational",
            "message": "Semiont API is running",
            "version": VERSION,
            "timestamp": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        }),
    )
}

/// `GET /api/openapi.json`: the spec this build serves, naming this build's
/// version and the URL this gateway is reached at.
pub async fn openapi(State(app): State<Arc<App>>) -> Response {
    let mut document = spec().document.clone();
    document["info"]["version"] = json!(VERSION);
    document["servers"] = json!([{ "url": app.config.public_url, "description": "API Server" }]);
    json_response(StatusCode::OK, &document)
}

/// `GET /.well-known/oauth-protected-resource` (RFC 9728): the issuer whose
/// tokens this knowledge base accepts. `resource` is the audience a token
/// must carry, read off the verifier.
pub async fn protected_resource(State(app): State<Arc<App>>) -> Response {
    json_response(
        StatusCode::OK,
        &json!({
            "resource": app.issuer.audience(),
            "authorization_servers": [app.issuer.issuer()],
            "bearer_methods_supported": ["header"],
            "resource_name": app.config.kb.name,
        }),
    )
}

/// `GET /api/status`: the gateway reports itself, and asks nothing of another service.
pub async fn status(Authenticated(principal): Authenticated) -> Response {
    json_response(
        StatusCode::OK,
        &json!({
            "status": "operational",
            "version": VERSION,
            "features": { "semanticContent": "planned", "collaboration": "planned", "rbac": "planned" },
            "message": "Ready to build the future of knowledge management!",
            "authenticatedAs": principal.email,
        }),
    )
}

/// `GET /api/users/me`: the bearer, as this knowledge base names them.
pub async fn me(Authenticated(principal): Authenticated) -> Response {
    json_response(
        StatusCode::OK,
        &json!({
            "did": principal.did,
            "email": principal.email,
            "name": principal.name,
            "image": principal.image,
            "domain": principal.domain,
        }),
    )
}
