//! The HTTP edge: connections the gateway can close from its side, what every
//! response carries, errors as the spec's ErrorResponse, and the bearer
//! credential.

use crate::app::App;
use crate::principal::{Principal, principal_from_token};
use axum::body::Body;
use axum::extract::{FromRequestParts, Request};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use futures::StreamExt;
use futures::task::AtomicWaker;
use hyper_util::rt::{TokioIo, TokioTimer};
use semiont::types::{ErrorResponse, LimitRefusal, LimitRefusalCode};
use semiont_observability::logging;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::task::{Context, Poll};
use std::time::Instant;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tower::ServiceExt;

pub const PROTECTED_RESOURCE_METADATA_PATH: &str = "/.well-known/oauth-protected-resource";

// ── Connections ──────────────────────────────────────────────────────────

/// Closes the connection a request arrived on: a stream whose client stopped
/// reading is torn down from this side, with what the connection held.
#[derive(Clone)]
pub struct ConnectionAbort(Arc<AbortState>);

struct AbortState {
    aborted: AtomicBool,
    waker: AtomicWaker,
}

impl ConnectionAbort {
    fn new() -> ConnectionAbort {
        ConnectionAbort(Arc::new(AbortState {
            aborted: AtomicBool::new(false),
            waker: AtomicWaker::new(),
        }))
    }

    pub fn abort(&self) {
        self.0.aborted.store(true, Ordering::SeqCst);
        self.0.waker.wake();
    }
}

struct Abortable {
    stream: TcpStream,
    state: Arc<AbortState>,
}

impl Abortable {
    fn aborted(&self, cx: &Context<'_>) -> bool {
        self.state.waker.register(cx.waker());
        self.state.aborted.load(Ordering::SeqCst)
    }
}

fn closed() -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionAborted, "closed by the gateway")
}

impl AsyncRead for Abortable {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.aborted(cx) {
            return Poll::Ready(Err(closed()));
        }
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for Abortable {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.aborted(cx) {
            return Poll::Ready(Err(closed()));
        }
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.aborted(cx) {
            return Poll::Ready(Err(closed()));
        }
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

/// Serve `router` on `listener` until `stop` resolves; then accept nothing more.
/// A connection past `connections` open at once is closed unanswered (capacity).
pub async fn serve(
    listener: TcpListener,
    router: axum::Router,
    connections: usize,
    stop: impl std::future::Future<Output = ()>,
) {
    tokio::pin!(stop);
    let open = Arc::new(AtomicUsize::new(0));
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                if open.load(Ordering::SeqCst) >= connections {
                    drop(stream);
                    crate::metrics::record_refused("connections");
                    continue;
                }
                open.fetch_add(1, Ordering::SeqCst);
                let _ = stream.set_nodelay(true);
                let (open, router) = (open.clone(), router.clone());
                tokio::spawn(async move {
                    connection(stream, router).await;
                    open.fetch_sub(1, Ordering::SeqCst);
                });
            }
            () = &mut stop => break,
        }
    }
}

async fn connection(stream: TcpStream, router: axum::Router) {
    let abort = ConnectionAbort::new();
    let io = TokioIo::new(Abortable {
        stream,
        state: abort.0.clone(),
    });
    let service = hyper::service::service_fn(
        move |mut request: axum::http::Request<hyper::body::Incoming>| {
            request.extensions_mut().insert(abort.clone());
            router.clone().oneshot(request.map(Body::new))
        },
    );
    let _ = hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .serve_connection(io, service)
        .await;
}

// ── Every response ───────────────────────────────────────────────────────

const SECURITY_HEADERS: [(&str, &str); 7] = [
    ("x-frame-options", "DENY"),
    ("x-content-type-options", "nosniff"),
    (
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
    ),
    (
        "content-security-policy",
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    ),
    ("x-xss-protection", "1; mode=block"),
    ("referrer-policy", "no-referrer"),
    (
        "permissions-policy",
        "camera=(), geolocation=(), microphone=(), payment=(), usb=(), interest-cohort=()",
    ),
];

/// A bearer-only API: any origin, never credentials.
fn allow_any_origin(headers: &mut HeaderMap) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
}

fn secure(headers: &mut HeaderMap, request_id: &str) {
    for (name, value) in SECURITY_HEADERS {
        headers.insert(name, HeaderValue::from_static(value));
    }
    if let Ok(id) = HeaderValue::from_str(request_id) {
        headers.insert("x-request-id", id);
    }
}

/// CORS, the security headers and a request id on every response, and a log
/// line for every request and response.
pub async fn edge(request: Request, next: Next) -> Response {
    let request_id = uuid::Uuid::new_v4().to_string();
    if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        let headers = response.headers_mut();
        allow_any_origin(headers);
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET,HEAD,PUT,POST,DELETE,PATCH"),
        );
        if let Some(requested) = request
            .headers()
            .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
        {
            headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, requested.clone());
            headers.insert(
                header::VARY,
                HeaderValue::from_static("Access-Control-Request-Headers"),
            );
        }
        secure(headers, &request_id);
        return response;
    }
    let (method, path) = (
        request.method().to_string(),
        request.uri().path().to_owned(),
    );
    let user_agent = request
        .headers()
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_owned();
    let started = Instant::now();
    let mut response = logging::REQUEST_ID
        .scope(request_id.clone(), async move {
            logging::info(
                "Incoming request",
                json!({ "type": "request_incoming", "method": method, "path": path, "query": request.uri().query(), "userAgent": user_agent }),
            );
            let response = next.run(request).await;
            let duration = started.elapsed().as_millis() as u64;
            logging::info(
                "Outgoing response",
                json!({ "type": "request_outgoing", "method": method, "path": path, "status": response.status().as_u16(), "duration": duration, "durationMs": duration }),
            );
            response
        })
        .await;
    let headers = response.headers_mut();
    allow_any_origin(headers);
    secure(headers, &request_id);
    response
}

// ── Errors ───────────────────────────────────────────────────────────────

/// A JSON body.
pub fn json_response(status: StatusCode, body: &impl Serialize) -> Response {
    let text = serde_json::to_string(body).expect("a response body serializes");
    let mut response = (status, text).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

/// Every error is an ErrorResponse, or a LimitRefusal when a limit refused it.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    body: Value,
    /// Headers the refusal carries: a 401's challenge, a limit's `Retry-After`.
    headers: Vec<(header::HeaderName, String)>,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> ApiError {
        let body = ErrorResponse {
            error: message.into(),
            code: None,
            hint: None,
            details: None,
        };
        ApiError {
            status,
            body: serde_json::to_value(body).expect("an ErrorResponse serializes"),
            headers: Vec::new(),
        }
    }

    /// A limit met (LimitRefusal): `code` names it, and `Retry-After` is when
    /// the refusal will have lifted, in whole seconds rounded up.
    pub fn limited(
        status: StatusCode,
        code: LimitRefusalCode,
        message: impl Into<String>,
        retry_after: std::time::Duration,
    ) -> ApiError {
        let seconds = retry_after.as_secs() + u64::from(retry_after.subsec_nanos() > 0);
        let body = serde_json::to_value(LimitRefusal {
            error: message.into(),
            code,
            hint: None,
            details: None,
        })
        .expect("a LimitRefusal serializes");
        crate::metrics::record_refused(
            body["code"]
                .as_str()
                .expect("a LimitRefusal names its code"),
        );
        ApiError {
            status,
            body,
            headers: vec![(header::RETRY_AFTER, seconds.to_string())],
        }
    }

    pub fn bad_request(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::BAD_REQUEST, message)
    }

    /// A 500 whose cause goes to the log and never to the caller.
    pub fn internal(what: &str, cause: impl std::fmt::Display) -> ApiError {
        logging::error(
            "Unhandled error during request processing",
            json!({ "type": "unhandled_error", "during": what, "error": cause.to_string() }),
        );
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
    }

    pub fn not_found() -> ApiError {
        ApiError::new(StatusCode::NOT_FOUND, "Not found")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = json_response(self.status, &self.body);
        for (name, value) in self.headers {
            if let Ok(value) = HeaderValue::from_str(&value) {
                response.headers_mut().insert(name, value);
            }
        }
        response
    }
}

/// The JSON body of `operation` ("POST /bus/emit"), whatever its content
/// type: refused with 413 when it is larger than the operation's
/// maxBodyBytes (unread, when its Content-Length says so), and with 400 when
/// it is not JSON or does not match the operation's schema.
pub async fn json_body(body: Body, operation: &str) -> Result<Value, ApiError> {
    let Some(accepts) = crate::limits::json_body(operation) else {
        return Err(ApiError::internal(
            "reading a request body",
            format!("the spec gives {operation} no JSON body"),
        ));
    };
    let too_large = || {
        ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "The body is larger than {} bytes, this operation's maxBodyBytes",
                accepts.max_bytes
            ),
        )
    };
    let declared = http_body::Body::size_hint(&body).lower();
    if declared > accepts.max_bytes as u64 {
        return Err(too_large());
    }
    let mut bytes = Vec::with_capacity(declared as usize);
    let mut data = body.into_data_stream();
    while let Some(chunk) = data.next().await {
        let chunk = chunk.map_err(|_| ApiError::bad_request("The body is not JSON"))?;
        if bytes.len() + chunk.len() > accepts.max_bytes {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::bad_request("The body is not JSON"))?;
    if let Some(problems) = semiont_core::spec::problems(&accepts.schema, &value) {
        return Err(ApiError::bad_request(problems));
    }
    Ok(value)
}

/// A string field of a body its schema has already accepted: absent, the
/// schema and this code disagree, which is the gateway's fault.
/// A JSON body held to its operation's schema (`json_body`), then read as its
/// type: once it validates, it cannot fail to decode.
pub async fn typed_body<T: DeserializeOwned>(body: Body, operation: &str) -> Result<T, ApiError> {
    let value = json_body(body, operation).await?;
    serde_json::from_value(value).map_err(|e| ApiError::internal("reading a validated body", e))
}

// ── The bearer credential ────────────────────────────────────────────────

/// The token an `Authorization: Bearer …` header carries: the scheme in any
/// case, whatever follows it trimmed; nothing following it is no token.
pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let scheme = value.get(..6)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let rest = &value[6..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let token = rest.trim_matches(|c: char| c.is_whitespace());
    (!token.is_empty()).then(|| token.to_owned())
}

/// The origin the caller reached, which the challenge names.
fn origin(headers: &HeaderMap) -> String {
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost");
    format!("http://{host}")
}

/// The `WWW-Authenticate` challenge on every 401 (RFC 6750 §3), naming the
/// resource's metadata (RFC 9728 §5.1), and `invalid_token` when a token was
/// presented and refused.
pub fn challenge(headers: &HeaderMap, invalid: bool) -> String {
    let metadata = format!(
        "resource_metadata=\"{}{PROTECTED_RESOURCE_METADATA_PATH}\"",
        origin(headers)
    );
    if invalid {
        format!("Bearer error=\"invalid_token\", {metadata}")
    } else {
        format!("Bearer {metadata}")
    }
}

/// The 401 for no credential: the challenge, and a hint naming the header.
pub fn missing_credential(headers: &HeaderMap) -> ApiError {
    ApiError {
        status: StatusCode::UNAUTHORIZED,
        body: json!({
            "error": "Unauthorized",
            "hint": "Authentication required: send an `Authorization: Bearer <token>` header. A raw browser navigation to a protected resource is unauthenticated.",
        }),
        headers: vec![(header::WWW_AUTHENTICATE, challenge(headers, false))],
    }
}

/// The 401 for a credential refused.
pub fn refused(headers: &HeaderMap, message: &str) -> ApiError {
    ApiError {
        status: StatusCode::UNAUTHORIZED,
        body: json!({ "error": message }),
        headers: vec![(header::WWW_AUTHENTICATE, challenge(headers, true))],
    }
}

/// The verified holder of the request's bearer token.
pub async fn authenticate(
    app: &App,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
) -> Result<Principal, ApiError> {
    let Some(token) = bearer_token(headers) else {
        logging::warn(
            "Authentication failed: No token",
            json!({ "type": "auth_failed", "reason": "missing_token", "path": path, "method": method.as_str() }),
        );
        return Err(missing_credential(headers));
    };
    match principal_from_token(
        &token,
        &app.issuer,
        &app.keys,
        &app.config.identity.subject_claim,
    )
    .await
    {
        Ok(principal) => {
            logging::debug(
                "Authentication successful",
                json!({ "type": "auth_success", "did": principal.did, "email": principal.email, "path": path, "method": method.as_str() }),
            );
            Ok(principal)
        }
        Err(error) => {
            logging::warn(
                "Authentication failed: Invalid token",
                json!({ "type": "auth_failed", "reason": "invalid_token", "path": path, "method": method.as_str(), "error": error }),
            );
            Err(refused(headers, "Invalid token"))
        }
    }
}

/// A route that needs a verified bearer. Extracted before any body is read.
pub struct Authenticated(pub Principal);

impl FromRequestParts<Arc<App>> for Authenticated {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        app: &Arc<App>,
    ) -> Result<Self, Self::Rejection> {
        authenticate(app, &parts.method, parts.uri.path(), &parts.headers)
            .await
            .map(Authenticated)
    }
}

/// `GET /api/resources/{id}`: a bearer, or the resource's own media token in `?token=`.
pub enum MediaOrBearer {
    Media,
    Bearer(Principal),
}

impl FromRequestParts<Arc<App>> for MediaOrBearer {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        app: &Arc<App>,
    ) -> Result<Self, Self::Rejection> {
        let media =
            axum::extract::Query::<std::collections::HashMap<String, String>>::try_from_uri(
                &parts.uri,
            )
            .ok()
            .and_then(|q| q.0.get("token").cloned())
            .filter(|t| !t.is_empty());
        let resource = parts
            .uri
            .path()
            .strip_prefix("/api/resources/")
            .filter(|id| !id.is_empty() && !id.contains('/'));
        if let (Some(token), Some(resource), true) = (media, resource, parts.method == Method::GET)
        {
            let resource = percent_encoding::percent_decode_str(resource)
                .decode_utf8_lossy()
                .into_owned();
            return match app.keys.verify_media(&token, &resource) {
                Ok(()) => Ok(MediaOrBearer::Media),
                Err(error) => {
                    logging::warn(
                        "Authentication failed: Invalid media token",
                        json!({ "type": "auth_failed", "reason": "invalid_media_token", "path": parts.uri.path(), "error": error }),
                    );
                    Err(refused(&parts.headers, "Invalid media token"))
                }
            };
        }
        authenticate(app, &parts.method, parts.uri.path(), &parts.headers)
            .await
            .map(MediaOrBearer::Bearer)
    }
}

/// Paths the gateway guards whatever the method, declared or not: a request
/// there is authenticated before it is told the route does not exist.
fn guarded(path: &str) -> bool {
    path == "/api/status"
        || ["/bus", "/resources", "/api/resources"]
            .iter()
            .any(|p| path == *p || path.starts_with(&format!("{p}/")))
}

/// Anything the spec does not declare: 404, after authentication where the path is guarded.
pub async fn not_found(
    axum::extract::State(app): axum::extract::State<Arc<App>>,
    request: Request,
) -> Response {
    let (parts, _) = request.into_parts();
    if guarded(parts.uri.path())
        && let Err(refusal) =
            authenticate(&app, &parts.method, parts.uri.path(), &parts.headers).await
    {
        return refusal.into_response();
    }
    ApiError::not_found().into_response()
}
