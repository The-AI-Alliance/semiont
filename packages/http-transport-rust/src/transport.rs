//! A knowledge base's bus over its gateway's HTTP transport
//! (docs/protocol/TRANSPORT-HTTP.md), as `semiont::transport::Transport`: one
//! stream, `POST /bus/subscribe`, naming the client's global channels and an
//! entry per resource scope it holds, and `POST /bus/emit` for what it sends.
//! The gateway's own operations ride plain request and response.
//!
//! The stream is `crate::actor`'s. What crosses the wire is observed here, as
//! every Semiont transport observes it: each emit is logged (`[bus EMIT]`),
//! counted (`semiont.bus.sent`) and sent in a `bus.emit` span whose trace
//! context travels as `traceparent`; each frame received is logged
//! (`[bus RECV]`), its trace lifted off the payload (`TRACE_FIELD`), and
//! marked by a `bus.recv` span in the trace it was sent under.

use crate::actor::{self, Command};
use semiont::bus_log::bus_log;
use semiont::channels::{BRIDGED_CHANNELS, RESOURCE_SCOPED_CHANNELS};
use semiont::errors::{BusRequestError, TransportError, TransportErrorCode};
use semiont::event_bus::EventBus;
use semiont::retry::{self, RetryFacts, RetryPolicy, retry_after, retry_with_backoff};
use semiont::timing;
use semiont::transport::{
    BoxFuture, ConnectionState, Envelope, Events, Failures, FrameHub, Frames, GatewayOperations,
    PendingReply, ReplyRouter, ResourceHold, STREAM_BACKLOG, TraceCarrier, Transport, unsubscribed,
};
use semiont::types::ResourceId;
use semiont::types::{
    BusEmitAccepted, BusEmitRequest, HealthResponse, LimitRefusal, LimitRefusalCode,
    MediaTokenRequest, MediaTokenResponse, ProtectedResourceMetadata, StatusResponse, UserResponse,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot, watch};

/// A request the gateway did not answer by its deadline.
fn unanswered(method: &reqwest::Method, path: &str, deadline: Duration) -> TransportError {
    TransportError::without_response(
        format!(
            "{method} {path} got no answer within {}s",
            deadline.as_secs()
        ),
        TransportErrorCode::Unavailable,
    )
}

/// How the sentence about a request that got no answer ends: within what,
/// when its deadline passed, or what kept it from being sent or answered.
pub(crate) fn why_unanswered(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        format!(" within {}s", timing::HTTP_REQUEST_TIMEOUT.as_secs())
    } else {
        format!(": {error}")
    }
}

/// How a transport renews its token when the gateway refuses the one it has:
/// renew it at its source, and say what it is now. `None` when it could not
/// be renewed. Whoever implements this also feeds the transport's token, so
/// the token has one source.
pub trait TokenRefresher: Send + Sync + 'static {
    fn refresh(&self) -> BoxFuture<'_, Option<String>>;
}

/// The timing a transport keeps, from specs/src/client/timing.json unless a
/// caller that must not wait it out (a test, a conformance driver) says
/// otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timing {
    pub reconnect: Duration,
    pub lazy_remove: Duration,
    pub linger: Duration,
    pub emit_retry: RetryPolicy,
    pub seen_event_ids: usize,
    /// The deadline on one request that is neither the stream nor an emit.
    pub http_request: Duration,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing {
            reconnect: timing::RECONNECT,
            lazy_remove: timing::LAZY_REMOVE,
            linger: timing::LINGER,
            emit_retry: timing::EMIT_RETRY,
            seen_event_ids: timing::SEEN_EVENT_IDS_COUNT,
            http_request: timing::HTTP_REQUEST_TIMEOUT,
        }
    }
}

/// Where a stream's place in each scope is kept across a client's lives: a
/// client that starts with the places its last life reached is sent what was
/// recorded since, and what it kept of those scopes is brought up to date by
/// replay.
pub trait Bookmarks: Send + Sync + 'static {
    /// The id of the last recorded event delivered on each scope, as kept.
    fn load(&self) -> HashMap<ResourceId, String>;
    /// A recorded event was delivered on `scope`.
    fn save(&self, scope: &ResourceId, event_id: &str);
}

pub struct HttpTransportConfig {
    /// The gateway's origin.
    pub base_url: String,
    /// The token every request carries: the current one, and each one after
    /// it. With none the transport sends nothing and waits for one.
    pub token: watch::Receiver<Option<String>>,
    /// Asked once per outage when the stream's credential is refused, and
    /// once per request whose credential is refused: a 401, or a 429
    /// `refusal-rate`. With none, a refused credential is final at once.
    pub refresher: Option<Arc<dyn TokenRefresher>>,
    /// The global channels the stream names. `None` is every channel a
    /// client hears (`BRIDGED_CHANNELS`); a process that awaits only some
    /// operations names their reply channels, and is not sent every other
    /// client's replies.
    pub channels: Option<Vec<String>>,
    pub http: reqwest::Client,
    pub timing: Timing,
    /// With none, the stream begins each life at the present.
    pub bookmarks: Option<Arc<dyn Bookmarks>>,
}

pub(crate) fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What the transport's handle and its stream both hold.
pub(crate) struct Shared {
    pub base_url: String,
    pub http: reqwest::Client,
    pub token: watch::Receiver<Option<String>>,
    pub refresher: Option<Arc<dyn TokenRefresher>>,
    /// This client's address for correlated replies: one per transport, not
    /// per connection, so both streams of a handoff present the same one.
    pub client_id: String,
    pub global: Vec<String>,
    pub timing: Timing,
    pub bookmarks: Option<Arc<dyn Bookmarks>>,
    pub hub: FrameHub,
    pub router: Arc<ReplyRouter>,
    /// The error stream; `None` once closed.
    pub failures: Mutex<Option<FailureStream>>,
    pub bridges: Mutex<Vec<Arc<EventBus>>>,
}

/// The error stream. The stream opens before `HttpTransport::new` returns,
/// so a failure can be reported before anyone has asked to hear failures:
/// the first listener's receiver is made with the stream and held until a
/// listener takes it, and nothing reported in the meantime is lost to it.
pub(crate) struct FailureStream {
    sender: broadcast::Sender<TransportError>,
    first: Option<broadcast::Receiver<TransportError>>,
}

impl FailureStream {
    fn new() -> FailureStream {
        let (sender, first) = broadcast::channel(STREAM_BACKLOG);
        FailureStream {
            sender,
            first: Some(first),
        }
    }

    /// A listener: the first one taken hears every failure reported since the
    /// stream was made, and each after it those reported from now on.
    fn listen(&mut self) -> broadcast::Receiver<TransportError> {
        match self.first.take() {
            Some(first) => first,
            None => self.sender.subscribe(),
        }
    }
}

impl Shared {
    /// What a transport's requests are made with. No stream is opened by
    /// this: `HttpTransport::new` starts the task that holds one.
    pub fn new(config: HttpTransportConfig) -> Shared {
        Shared {
            base_url: config.base_url.trim_end_matches('/').to_owned(),
            http: config.http,
            token: config.token,
            refresher: config.refresher,
            client_id: uuid::Uuid::new_v4().to_string(),
            global: config.channels.unwrap_or_else(|| {
                BRIDGED_CHANNELS
                    .iter()
                    .map(|channel| (*channel).to_owned())
                    .collect()
            }),
            timing: config.timing,
            bookmarks: config.bookmarks,
            hub: FrameHub::new(),
            router: ReplyRouter::new(),
            failures: Mutex::new(Some(FailureStream::new())),
            bridges: Mutex::new(Vec::new()),
        }
    }

    /// Who the gateway says this token is.
    pub async fn current_user(&self) -> Result<UserResponse, TransportError> {
        self.answer(reqwest::Method::GET, "/api/users/me", true, |request| {
            request
        })
        .await
    }

    pub fn current_token(&self) -> Option<String> {
        self.token
            .borrow()
            .clone()
            .filter(|token| !token.is_empty())
    }

    /// Report a failure on the error stream, and hand it back for its caller.
    pub fn failed(&self, error: TransportError) -> TransportError {
        if let Some(failures) = locked(&self.failures).as_ref() {
            let _ = failures.sender.send(error.clone());
        }
        error
    }

    /// The token to send a request again with once `refused` was refused:
    /// the refresher's, asked once. None when there is no refresher, or it
    /// gives no token or the one refused.
    async fn renewal(&self, refused: Option<&str>) -> Option<String> {
        let refresher = self.refresher.as_ref()?;
        refresher
            .refresh()
            .await
            .filter(|renewed| Some(renewed.as_str()) != refused)
    }

    /// One request and its answer. A request whose credential is refused is
    /// sent again once, at once, with a renewed token that is not the one
    /// refused, on any method; it is never retried. Any other request is
    /// made a second time when that is worth it and safe
    /// (`retry::TRANSPORT`): a status that promises recovery, or no answer
    /// at all, on a method that cannot cause a second effect. A failure is
    /// reported on the error stream as it is returned.
    ///
    /// An attempt whose answer has not begun by the transport's deadline
    /// (`Timing::http_request`) fails as one that got no answer, and is not
    /// made again: the gateway has the request, and may yet act on it.
    pub async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        authenticated: bool,
        build: impl Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, TransportError> {
        self.exchange(
            method,
            path,
            authenticated,
            Some(self.timing.http_request),
            build,
        )
        .await
    }

    /// `send`, with the deadline stated: `None` waits for as long as it
    /// takes.
    async fn exchange(
        &self,
        method: reqwest::Method,
        path: &str,
        authenticated: bool,
        deadline: Option<Duration>,
        build: impl Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, TransportError> {
        let url = format!("{}{path}", self.base_url);
        let repeatable = retry::TRANSPORT.retryable(&RetryFacts {
            status: Some(503),
            method: Some(method.as_str()),
        });
        let mut token = self.current_token();
        let mut retried = false;
        let mut renewed = false;
        loop {
            let mut request = build(self.http.request(method.clone(), &url));
            if authenticated && let Some(token) = &token {
                request = request.bearer_auth(token);
            }
            if let Some(TraceCarrier {
                traceparent,
                tracestate,
            }) = semiont_telemetry::active_trace()
            {
                request = request.header("traceparent", traceparent);
                if let Some(tracestate) = tracestate {
                    request = request.header("tracestate", tracestate);
                }
            }
            let sent = match deadline {
                Some(deadline) => match tokio::time::timeout(deadline, request.send()).await {
                    Ok(sent) => sent,
                    Err(_) => return Err(self.failed(unanswered(&method, path, deadline))),
                },
                None => request.send().await,
            };
            let response = match sent {
                Ok(response) => response,
                Err(error) => {
                    if !retried && repeatable {
                        retried = true;
                        tokio::time::sleep(timing::REQUEST_RETRY_PAUSE).await;
                        continue;
                    }
                    return Err(self.failed(TransportError::without_response(
                        format!("{method} {path} got no answer: {error}"),
                        TransportErrorCode::Unavailable,
                    )));
                }
            };
            if response.status().is_success() {
                return Ok(response);
            }
            let status = response.status().as_u16();
            let stated_wait = stated_wait(&response);
            let body = response.json::<Value>().await.ok();
            let message = body
                .as_ref()
                .and_then(|body| {
                    ["message", "error"]
                        .iter()
                        .find_map(|key| body.get(*key).and_then(Value::as_str).map(str::to_owned))
                })
                .unwrap_or_else(|| {
                    // Worded as the TypeScript transport words it.
                    let reason = reqwest::StatusCode::from_u16(status)
                        .ok()
                        .and_then(|code| code.canonical_reason())
                        .unwrap_or_default();
                    format!("HTTP {status}: {reason}")
                });
            let refused = refusal(message, status, stated_wait, body.as_ref());
            if refused.code == TransportErrorCode::Unauthorized {
                if !renewed && let Some(fresh) = self.renewal(token.as_deref()).await {
                    token = Some(fresh);
                    renewed = true;
                    continue;
                }
            } else if !retried
                && retry::TRANSPORT.retryable(&RetryFacts {
                    status: Some(status),
                    method: Some(method.as_str()),
                })
            {
                retried = true;
                tokio::time::sleep(
                    timing::REQUEST_RETRY_PAUSE.max(stated_wait.unwrap_or_default()),
                )
                .await;
                continue;
            }
            return Err(self.failed(refused));
        }
    }

    /// The same, read as the JSON the operation answers. The answer, once
    /// begun, is read within the same deadline.
    pub async fn answer<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        authenticated: bool,
        build: impl Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
    ) -> Result<T, TransportError> {
        self.answered(
            method,
            path,
            authenticated,
            Some(self.timing.http_request),
            build,
        )
        .await
    }

    /// `answer` with no deadline, for an upload: how long one takes is how
    /// large the resource is.
    pub async fn answer_at_length<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        authenticated: bool,
        build: impl Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
    ) -> Result<T, TransportError> {
        self.answered(method, path, authenticated, None, build)
            .await
    }

    async fn answered<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        authenticated: bool,
        deadline: Option<Duration>,
        build: impl Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
    ) -> Result<T, TransportError> {
        let response = self
            .exchange(method.clone(), path, authenticated, deadline, build)
            .await?;
        let status = response.status().as_u16();
        let read = match deadline {
            Some(deadline) => tokio::time::timeout(deadline, response.json::<T>())
                .await
                .map_err(|_| self.failed(unanswered(&method, path, deadline)))?,
            None => response.json::<T>().await,
        };
        read.map_err(|error| {
            self.failed(TransportError {
                code: TransportErrorCode::Error,
                status: Some(status),
                message: format!("{method} {path} answered what is not its declared body: {error}"),
                retry_after: None,
            })
        })
    }

    /// One emit: `POST /bus/emit`, each attempt bounded by `EMIT_TIMEOUT`,
    /// made again inside the emit budget when a limit refused it, the
    /// gateway said it will recover, or nothing answered; no sooner than a
    /// refusal's `Retry-After`. An emit whose credential is refused is never
    /// retried: it is sent again once, at once, with a renewed token that is
    /// not the one refused, under a budget of its own. Any other refusal is
    /// final.
    async fn emit(&self, body: &BusEmitRequest) -> Result<Option<u64>, TransportError> {
        let url = format!("{}/bus/emit", self.base_url);
        let trace = semiont_telemetry::active_trace();
        let mut token = self.current_token();
        let mut renewed = false;
        loop {
            let sent = token.as_deref();
            let attempt = || async {
                let mut request = self
                    .http
                    .post(&url)
                    .bearer_auth(sent.unwrap_or_default())
                    .timeout(timing::EMIT_TIMEOUT)
                    .json(body);
                if let Some(TraceCarrier {
                    traceparent,
                    tracestate,
                }) = &trace
                {
                    request = request.header("traceparent", traceparent);
                    if let Some(tracestate) = tracestate {
                        request = request.header("tracestate", tracestate);
                    }
                }
                let response = request.send().await.map_err(|error| {
                    TransportError::without_response(
                        format!("/bus/emit got no answer: {error}"),
                        TransportErrorCode::Unavailable,
                    )
                })?;
                if !response.status().is_success() {
                    let status = response.status().as_u16();
                    let stated_wait = stated_wait(&response);
                    let answered = response.text().await.unwrap_or_default();
                    let detail: String = answered.chars().take(500).collect();
                    let message = if detail.is_empty() {
                        format!("/bus/emit {status}")
                    } else {
                        format!("/bus/emit {status}: {detail}")
                    };
                    let said = serde_json::from_str::<Value>(&answered).ok();
                    return Err(refusal(message, status, stated_wait, said.as_ref()));
                }
                // No count is reported as no count, never as a zero: an absent
                // `subscribers` is the gateway saying it could not count, and an
                // unreadable body says nothing at all.
                Ok(response
                    .json::<BusEmitAccepted>()
                    .await
                    .ok()
                    .and_then(|accepted| accepted.subscribers))
            };
            let emitted = retry_with_backoff(
                self.timing.emit_retry,
                attempt,
                |error: &TransportError| {
                    error.code != TransportErrorCode::Unauthorized
                        && match error.status {
                            Some(status) => retry::BOOT.retryable(&RetryFacts {
                                status: Some(status),
                                method: Some("POST"),
                            }),
                            None => true,
                        }
                },
                |error| error.retry_after,
            )
            .await;
            match emitted {
                Err(refused) if refused.code == TransportErrorCode::Unauthorized && !renewed => {
                    let Some(fresh) = self.renewal(sent).await else {
                        return Err(self.failed(refused));
                    };
                    token = Some(fresh);
                    renewed = true;
                }
                emitted => return emitted.map_err(|error| self.failed(error)),
            }
        }
    }
}

/// A refusal, as the transport reports it. A refused credential
/// (docs/protocol/TRANSPORT-CONTRACT.md § A refused credential) is
/// `unauthorized` with the status the gateway answered, whatever that was.
/// It keeps the wait the gateway stated, which nothing waits out: it is
/// renewed, never retried. Any other refusal's status decides its code.
pub(crate) fn refusal(
    message: String,
    status: u16,
    stated_wait: Option<Duration>,
    body: Option<&Value>,
) -> TransportError {
    if refuses_credential(status, body) {
        TransportError {
            code: TransportErrorCode::Unauthorized,
            status: Some(status),
            message,
            retry_after: stated_wait,
        }
    } else {
        TransportError::of_status(message, status, stated_wait)
    }
}

/// Whether the gateway refused the request's credential: a 401, or a 429
/// whose body is a LimitRefusal naming `refusal-rate`. A 429 whose body is
/// not one is a limit's, as its status says.
pub(crate) fn refuses_credential(status: u16, body: Option<&Value>) -> bool {
    match status {
        401 => true,
        429 => body.is_some_and(|body| {
            LimitRefusal::deserialize(body)
                .is_ok_and(|refusal| refusal.code == LimitRefusalCode::RefusalRate)
        }),
        _ => false,
    }
}

fn stated_wait(response: &reqwest::Response) -> Option<Duration> {
    retry_after(
        response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok()),
    )
}

struct Inner {
    shared: Arc<Shared>,
    commands: mpsc::UnboundedSender<Command>,
    state: watch::Receiver<ConnectionState>,
    /// How many holds each resource's scope has.
    holds: Arc<Mutex<HashMap<ResourceId, usize>>>,
    closed: AtomicBool,
}

/// See the module's documentation. A handle: cloning it gives another to the
/// same transport, and the transport stops when it is closed or the last one
/// is dropped.
#[derive(Clone)]
pub struct HttpTransport {
    inner: Arc<Inner>,
}

impl HttpTransport {
    /// A transport to the gateway at `config.base_url`. Its stream opens in
    /// the background, once there is a token. The first listener taken of its
    /// failures hears them from the transport's making.
    pub fn new(config: HttpTransportConfig) -> HttpTransport {
        let shared = Arc::new(Shared::new(config));
        let (commands, receiver) = mpsc::unbounded_channel();
        let (state, state_reader) = watch::channel(ConnectionState::Initial);
        tokio::spawn(actor::run(shared.clone(), state, receiver));
        HttpTransport {
            inner: Arc::new(Inner {
                shared,
                commands,
                state: state_reader,
                holds: Arc::new(Mutex::new(HashMap::new())),
                closed: AtomicBool::new(false),
            }),
        }
    }

    pub(crate) fn shared(&self) -> &Arc<Shared> {
        &self.inner.shared
    }
}

impl Transport for HttpTransport {
    fn base_url(&self) -> &str {
        &self.inner.shared.base_url
    }

    fn emit<'a>(
        &'a self,
        channel: &'a str,
        payload: Map<String, Value>,
        envelope: Envelope,
    ) -> BoxFuture<'a, Result<Option<u64>, TransportError>> {
        Box::pin(async move {
            let shared = &self.inner.shared;
            let scope = envelope.scope.filter(|scope| !scope.is_empty());
            bus_log(
                "EMIT",
                channel,
                &Value::Object(payload.clone()),
                scope.as_deref(),
                envelope.correlation_id.as_deref(),
            );
            let body = BusEmitRequest {
                channel: channel.to_owned(),
                payload,
                scope,
                client_id: Some(shared.client_id.clone()),
                correlation_id: envelope.correlation_id,
            };
            semiont_telemetry::bus_emit(channel, body.scope.as_deref(), shared.emit(&body)).await
        })
    }

    fn frames(&self, channel: &str) -> Result<Frames, BusRequestError> {
        // A channel this stream can never carry would be a stream that never
        // fires, which reads as a quiet system: refused at the call. A
        // resource-scoped channel passes with no scope held yet, since frames
        // flow the moment one is.
        if !self.is_subscribed(channel) && !RESOURCE_SCOPED_CHANNELS.contains(&channel) {
            return Err(unsubscribed(channel));
        }
        Ok(self.inner.shared.hub.frames(channel))
    }

    fn is_subscribed(&self, channel: &str) -> bool {
        self.inner.shared.global.iter().any(|c| c == channel)
    }

    fn subscribe_to_resource(&self, resource_id: &ResourceId) -> ResourceHold {
        let resource = resource_id.clone();
        let holds = self.inner.holds.clone();
        let commands = self.inner.commands.clone();
        {
            let mut holds = locked(&holds);
            let count = holds.entry(resource.clone()).or_insert(0);
            *count += 1;
            if *count == 1 {
                let _ = commands.send(Command::AddScope(resource.clone()));
            }
        }
        ResourceHold::new(move || {
            let mut holds = locked(&holds);
            let Some(count) = holds.get_mut(&resource) else {
                return;
            };
            *count -= 1;
            if *count == 0 {
                holds.remove(&resource);
                let _ = commands.send(Command::RemoveScope(resource));
            }
        })
    }

    fn state(&self) -> watch::Receiver<ConnectionState> {
        self.inner.state.clone()
    }

    fn failures(&self) -> Failures {
        match locked(&self.inner.shared.failures).as_mut() {
            Some(failures) => Events::new(failures.listen()),
            None => Events::new(broadcast::channel(1).1),
        }
    }

    fn track_reply(&self, correlation_id: &str, reply_channels: &[&str]) -> PendingReply {
        self.inner
            .shared
            .router
            .track(correlation_id, reply_channels)
    }

    fn bridge_into(&self, bus: Arc<EventBus>) {
        locked(&self.inner.shared.bridges).push(bus);
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if self.inner.closed.swap(true, Ordering::SeqCst) {
                return;
            }
            let (done, closed) = oneshot::channel();
            if self.inner.commands.send(Command::Close(done)).is_ok() {
                let _ = closed.await;
            }
        })
    }
}

impl GatewayOperations for HttpTransport {
    fn get_current_user(&self) -> BoxFuture<'_, Result<UserResponse, TransportError>> {
        Box::pin(self.inner.shared.current_user())
    }

    fn get_media_token<'a>(
        &'a self,
        resource_id: &'a ResourceId,
    ) -> BoxFuture<'a, Result<MediaTokenResponse, TransportError>> {
        Box::pin(async move {
            let body = MediaTokenRequest {
                resource_id: resource_id.clone(),
            };
            self.inner
                .shared
                .answer(
                    reqwest::Method::POST,
                    "/api/tokens/media",
                    true,
                    |request| request.json(&body),
                )
                .await
        })
    }

    fn get_protected_resource_metadata(
        &self,
    ) -> BoxFuture<'_, Result<ProtectedResourceMetadata, TransportError>> {
        Box::pin(self.inner.shared.answer(
            reqwest::Method::GET,
            "/.well-known/oauth-protected-resource",
            false,
            |request| request,
        ))
    }

    fn health_check(&self) -> BoxFuture<'_, Result<HealthResponse, TransportError>> {
        Box::pin(
            self.inner
                .shared
                .answer(reqwest::Method::GET, "/api/health", true, |request| request),
        )
    }

    fn get_status(&self) -> BoxFuture<'_, Result<StatusResponse, TransportError>> {
        Box::pin(
            self.inner
                .shared
                .answer(reqwest::Method::GET, "/api/status", true, |request| request),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_credential_is_refused_by_a_401_or_a_429_refusal_rate_and_by_nothing_else() {
        let limit = |code: &str| json!({ "error": "a limit was met", "code": code });
        let wait = Some(Duration::from_secs(1));

        let refused = refusal(
            "refused".to_owned(),
            429,
            wait,
            Some(&limit("refusal-rate")),
        );
        assert_eq!(
            (refused.code, refused.status, refused.retry_after),
            (TransportErrorCode::Unauthorized, Some(429), wait),
            "a refused credential keeps the wait it was told, and is still unauthorized"
        );
        let refused = refusal("refused".to_owned(), 401, None, None);
        assert_eq!(
            (refused.code, refused.status),
            (TransportErrorCode::Unauthorized, Some(401))
        );

        for body in [
            Some(limit("emit-rate")),
            Some(json!({ "error": "a limit with no code" })),
            Some(limit("a-code-from-the-future")),
            None,
        ] {
            let limited = refusal("limited".to_owned(), 429, wait, body.as_ref());
            assert_eq!(
                (limited.code, limited.retry_after),
                (TransportErrorCode::RateLimited, wait),
                "{body:?}"
            );
        }
        let forbidden = refusal(
            "forbidden".to_owned(),
            403,
            None,
            Some(&limit("refusal-rate")),
        );
        assert_eq!(forbidden.code, TransportErrorCode::Forbidden);
    }
}
