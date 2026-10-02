//! The tokens the gateway mints: an agent token for a service account, and a
//! media token for a signed-in caller.

use crate::app::App;
use crate::http::{
    ApiError, Authenticated, Unauthenticated, json_response, missing_credential, refused,
    typed_body,
};
use crate::principal::authorize_minter;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use semiont::identity;
use semiont::roles::WORKER_ROLE;
use semiont::types::UserId;
use semiont::types::{
    AgentTokenRequest, AgentTokenResponse, MediaTokenRequest, MediaTokenResponse,
};
use semiont_observability::logging;
use serde_json::json;
use std::sync::Arc;

/// `POST /api/tokens/agent`: a service account, verified at the issuer and
/// carrying the service role, exchanges its token for one naming the
/// (provider, model) its work runs as. The process is the service account;
/// the agent is the work. Only the worker role is delegated.
pub async fn agent(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let Some(bearer) = crate::http::bearer_token(&headers) else {
        return Err(missing_credential(&headers));
    };
    let minter = authorize_minter(&bearer, &app.issuer)
        .await
        .map_err(|refusal| {
            logging::warn("Agent token refused", json!({ "reason": refusal.reason }));
            refused(&headers, Unauthenticated::InvalidToken, &refusal.message)
        })?;
    let request: AgentTokenRequest = typed_body(body, "POST /api/tokens/agent").await?;
    let (provider, model) = (request.provider.as_str(), request.model.as_str());
    let domain = app.keys.domain();
    let did = identity::agent_did(domain, provider, model);
    logging::info(
        "Agent token issued",
        json!({ "minter": minter.client, "did": did, "worker": minter.worker_capable }),
    );
    let worker = [WORKER_ROLE.to_owned()];
    let token = app.keys.agent_token(
        &did,
        &identity::agent_address(domain, provider, model),
        &identity::agent_name(provider, model),
        minter.worker_capable.then_some(&worker[..]),
    );
    Ok(json_response(
        StatusCode::OK,
        &AgentTokenResponse {
            token,
            did: UserId::new(did).map_err(|e| ApiError::internal("naming an agent", e))?,
        },
    ))
}

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
