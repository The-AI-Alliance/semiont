//! The tokens the gateway mints: an agent token for a service account, and a
//! media token for a signed-in caller.

use crate::app::App;
use crate::http::{
    ApiError, Authenticated, json_body, json_response, missing_credential, refused, text,
};
use crate::identity;
use crate::logging;
use crate::principal::authorize_minter;
use crate::roles::WORKER_ROLE;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
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
            refused(&headers, &refusal.message)
        })?;
    let request = json_body(body, "AgentTokenRequest").await?;
    let (provider, model) = (text(&request, "provider")?, text(&request, "model")?);
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
        &json!({ "token": token, "did": did }),
    ))
}

/// `POST /api/tokens/media`: a token naming one resource for five minutes,
/// for the links that cannot send a header.
pub async fn media(
    State(app): State<Arc<App>>,
    Authenticated(_): Authenticated,
    body: Body,
) -> Result<Response, ApiError> {
    let request = json_body(body, "MediaTokenRequest").await?;
    let resource = text(&request, "resourceId")?;
    Ok(json_response(
        StatusCode::OK,
        &json!({ "token": app.keys.media_token(resource) }),
    ))
}
