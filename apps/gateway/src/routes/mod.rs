//! The route table: every operation the spec declares, and nothing else.
//! The router is built from this table, and before the gateway listens the
//! table is compared with the spec's operations; any difference stops it.

mod bus;
mod content;
mod meta;
mod stream;
mod tokens;

use crate::app::App;
use crate::http::{edge, not_found};
use axum::Router;
use axum::routing::{MethodRouter, get, post};
use semiont_core::spec::{self, spec};
use std::sync::Arc;

type Route = (&'static str, &'static str, fn() -> MethodRouter<Arc<App>>);

const ROUTES: [Route; 14] = [
    ("GET", "/", || get(meta::health)),
    ("GET", "/api/health", || get(meta::health)),
    ("GET", "/api/openapi.json", || get(meta::openapi)),
    ("GET", "/.well-known/oauth-protected-resource", || {
        get(meta::protected_resource)
    }),
    ("GET", "/api/status", || get(meta::status)),
    ("GET", "/api/users/me", || get(meta::me)),
    ("POST", "/api/tokens/agent", || post(tokens::agent)),
    ("POST", "/api/tokens/media", || post(tokens::media)),
    ("POST", "/resources", || post(content::upload)),
    ("GET", "/resources/{id}", || get(content::pipe)),
    ("GET", "/resources/{id}/jsonld", || {
        get(content::description)
    }),
    ("GET", "/api/resources/{id}", || get(content::media_pipe)),
    ("POST", "/bus/emit", || post(bus::emit)),
    ("POST", "/bus/subscribe", || post(stream::subscribe)),
];

pub fn router(app: Arc<App>) -> Router {
    let mut router = Router::new();
    for (_, path, handler) in ROUTES {
        router = router.route(path, handler());
    }
    router
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(axum::middleware::from_fn(edge))
        .with_state(app)
}

/// Every difference between the routes served and the operations the spec declares.
pub fn mismatches() -> Vec<String> {
    spec::route_mismatches(&spec().document, ROUTES.iter().map(|(m, p, _)| (*m, *p)))
}
