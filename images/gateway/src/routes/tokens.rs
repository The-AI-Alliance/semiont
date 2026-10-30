//! The token the gateway mints: a media token for a signed-in caller.

use crate::app::App;
use crate::http::{ApiError, Authenticated, json_response, typed_body};
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use semiont::types::{MediaTokenRequest, MediaTokenResponse};
use std::sync::Arc;

/// `POST /api/tokens/media`: a token naming one resource for five minutes,
/// for the links that cannot send a header.
pub async fn media(
    State(app): State<Arc<App>>,
    Authenticated(_): Authenticated,
    body: Body,
) -> Result<Response, ApiError> {
    let request: MediaTokenRequest = typed_body(body, "POST /api/tokens/media").await?;
    let token = app.keys.media_token(request.resource_id.as_str());
    Ok(json_response(StatusCode::OK, &MediaTokenResponse { token }))
}
