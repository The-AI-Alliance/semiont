//! `POST /bus/subscribe`: one Server-Sent Events stream per connection,
//! carrying every frame on the channels and scopes it names — a correlated
//! reply only to the client and principal whose request it answers — after a
//! replay of each watermarked scope's persisted events and of the replies it
//! names in `pendingReplies`; then a ping every `heartbeatSeconds`.
//!
//! Two bounds hold a connection (the operation's `x-semiont-limits`): a
//! subscriber that stops reading is disconnected once `pendingWriteBytes` are
//! waiting for it, and a replay that live frames outrun past
//! `replayBufferEvents` is abandoned. Opening and closing a stream is
//! presence: `session:joined` and `session:left`.

use crate::app::App;
use crate::bus_log::bus_log;
use crate::http::{ApiError, Authenticated, ConnectionAbort, json_body, text};
use crate::ledger::DeliveryGate;
use crate::logging;
use crate::signal::{ClientSubscription, Frame, ScopedChannels, Subscription};
use crate::spec::{Limits, spec};
use crate::telemetry;
use axum::Extension;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use bytes::Bytes;
use opentelemetry::KeyValue;
use opentelemetry::trace::SpanKind;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};
use std::time::Duration;
use tokio::sync::Notify;

/// Scopes on one connection past which the matrix is logged as large.
const SCOPE_WARN_THRESHOLD: usize = 128;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

fn bus(fields: Value) -> Value {
    let mut fields = fields;
    fields["component"] = json!("bus");
    fields
}

struct Scoped {
    scope: String,
    channels: Vec<String>,
    last_event_id: Option<String>,
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

pub async fn subscribe(
    State(app): State<Arc<App>>,
    Authenticated(principal): Authenticated,
    Extension(abort): Extension<ConnectionAbort>,
    body: Body,
) -> Result<Response, ApiError> {
    let request = json_body(body, "POST /bus/subscribe").await?;
    let client_id = text(&request, "clientId")?.to_owned();
    let global = strings(&request["global"]);
    let mut scoped = Vec::new();
    for entry in request["scoped"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        scoped.push(Scoped {
            scope: text(entry, "scope")?.to_owned(),
            channels: strings(&entry["channels"]),
            last_event_id: entry["lastEventId"].as_str().map(str::to_owned),
        });
    }
    let pending_replies = strings(&request["pendingReplies"]);
    if global.is_empty() && scoped.is_empty() {
        return Err(ApiError::bad_request(
            "At least one global channel or scoped entry is required",
        ));
    }
    let mut seen = HashSet::new();
    for entry in &scoped {
        if !seen.insert(entry.scope.clone()) {
            return Err(ApiError::bad_request(format!(
                "duplicate scope \"{}\" in matrix",
                entry.scope
            )));
        }
    }
    if scoped.len() >= SCOPE_WARN_THRESHOLD {
        logging::warn(
            "large scope matrix",
            bus(json!({ "scopeCount": scoped.len() })),
        );
    }

    let connection = Connection::new(
        app,
        principal.did,
        client_id,
        abort,
        !scoped.iter().all(|e| e.last_event_id.is_none()),
    );
    let body = Body::from_stream(Outgoing {
        connection: connection.clone(),
    });
    tokio::spawn(connection.run(global, scoped, pending_replies));

    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    Ok(response)
}

/// Bytes waiting for the client, and what they cost.
struct Outbox {
    queue: VecDeque<Bytes>,
    /// Bytes written for this subscriber and not yet taken by its connection.
    pending: usize,
    waker: Option<Waker>,
}

/// A frame that arrived while the replay ran, waiting for it to finish.
struct Queued {
    channel: String,
    payload: Arc<Value>,
    scope: Option<String>,
    correlation_id: Option<String>,
    trace: Option<(String, Option<String>)>,
}

struct Delivery {
    buffering: bool,
    buffer: Vec<Queued>,
    /// The last persisted sequence delivered per scope: live frames a replay
    /// already delivered are not delivered twice.
    last_sequence: HashMap<String, u64>,
}

struct Connection {
    app: Arc<App>,
    id: String,
    did: String,
    client_id: String,
    limits: Limits,
    abort: ConnectionAbort,
    outbox: Mutex<Outbox>,
    delivery: Mutex<Delivery>,
    ephemeral: AtomicU64,
    torn_down: AtomicBool,
    ended: Notify,
    subscription: Mutex<Option<Subscription>>,
    gate: Arc<DeliveryGate>,
}

/// The response body: whatever the connection has written, as the client takes it.
struct Outgoing {
    connection: Arc<Connection>,
}

impl futures::Stream for Outgoing {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let connection = &self.connection;
        if connection.torn_down.load(Ordering::SeqCst) {
            return Poll::Ready(Some(Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "the stream was closed",
            ))));
        }
        let mut outbox = locked(&connection.outbox);
        match outbox.queue.pop_front() {
            Some(chunk) => {
                outbox.pending = outbox.pending.saturating_sub(chunk.len());
                Poll::Ready(Some(Ok(chunk)))
            }
            None => {
                outbox.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

impl Drop for Outgoing {
    fn drop(&mut self) {
        self.connection.teardown("stream-abort");
    }
}

fn sequence_of(payload: &Value) -> Option<u64> {
    payload["metadata"]["sequenceNumber"].as_u64()
}

/// A persisted id, `p-<scope>-<sequence>`.
fn parse_persisted(raw: &str) -> Option<(String, u64)> {
    let body = raw.strip_prefix("p-")?;
    let dash = body.rfind('-')?;
    if dash == 0 || dash == body.len() - 1 {
        return None;
    }
    let sequence: u64 = body[dash + 1..].parse().ok()?;
    Some((body[..dash].to_owned(), sequence))
}

fn trace_of(meta: Option<&HashMap<String, String>>) -> Option<(String, Option<String>)> {
    let meta = meta?;
    Some((
        meta.get("traceparent")?.clone(),
        meta.get("tracestate").cloned(),
    ))
}

impl Connection {
    fn new(
        app: Arc<App>,
        did: String,
        client_id: String,
        abort: ConnectionAbort,
        buffering: bool,
    ) -> Arc<Connection> {
        let gate = app.bus.ledger.gate(&client_id, Some(&did));
        Arc::new(Connection {
            limits: spec().limits(),
            id: uuid::Uuid::new_v4().to_string(),
            app,
            did,
            client_id,
            abort,
            outbox: Mutex::new(Outbox {
                queue: VecDeque::new(),
                pending: 0,
                waker: None,
            }),
            delivery: Mutex::new(Delivery {
                buffering,
                buffer: Vec::new(),
                last_sequence: HashMap::new(),
            }),
            ephemeral: AtomicU64::new(0),
            torn_down: AtomicBool::new(false),
            ended: Notify::new(),
            subscription: Mutex::new(None),
            gate,
        })
    }

    fn torn_down(&self) -> bool {
        self.torn_down.load(Ordering::SeqCst)
    }

    fn next_ephemeral(&self) -> String {
        format!(
            "e-{}-{}",
            self.id,
            self.ephemeral.fetch_add(1, Ordering::SeqCst) + 1
        )
    }

    /// Every message leaves through here, so `pending` counts exactly what
    /// this subscriber makes the gateway hold. Past the bound it is disconnected.
    fn write(self: &Arc<Self>, event: &str, data: &str, id: Option<&str>) {
        let mut message = format!("event: {event}\n");
        for line in data.split('\n') {
            message.push_str("data: ");
            message.push_str(line);
            message.push('\n');
        }
        if let Some(id) = id {
            message.push_str(&format!("id: {id}\n"));
        }
        message.push('\n');
        let overflow = {
            let mut outbox = locked(&self.outbox);
            if self.torn_down() {
                return;
            }
            outbox.pending += data.len();
            if outbox.pending > self.limits.pending_write_bytes {
                Some(outbox.pending)
            } else {
                outbox.queue.push_back(Bytes::from(message));
                if let Some(waker) = outbox.waker.take() {
                    waker.wake();
                }
                None
            }
        };
        if let Some(pending) = overflow {
            logging::warn(
                "SSE pending-write overflow — disconnecting dead or stalled subscriber",
                bus(
                    json!({ "connectionId": self.id, "pendingBytes": pending, "cap": self.limits.pending_write_bytes }),
                ),
            );
            self.teardown("pending-write-overflow");
        }
    }

    /// One frame, stamped with its id: persisted when it is scoped and carries
    /// a sequence number, `e-<channel>:<correlationId>` when it is a reply
    /// (the same on every connection it reaches), otherwise this connection's
    /// own. A reply's delivery is a span; the frame carries the trace on.
    fn deliver(self: &Arc<Self>, delivery: &mut Delivery, frame: Queued) {
        let Queued {
            channel,
            payload,
            scope,
            correlation_id,
            trace,
        } = frame;
        let id = match (sequence_of(&payload), &scope) {
            (Some(sequence), Some(scope)) => {
                if delivery
                    .last_sequence
                    .get(scope)
                    .is_some_and(|delivered| sequence <= *delivered)
                {
                    return;
                }
                delivery.last_sequence.insert(scope.clone(), sequence);
                format!("p-{scope}-{sequence}")
            }
            _ => match correlation_id.as_deref().filter(|c| !c.is_empty()) {
                Some(cid) => format!("e-{channel}:{cid}"),
                None => self.next_ephemeral(),
            },
        };
        let parent = match &trace {
            Some((traceparent, tracestate)) => {
                telemetry::continued(Some(traceparent), tracestate.as_deref())
            }
            None => opentelemetry::Context::current(),
        };
        let write = || {
            let mut payload = (*payload).clone();
            if let (Value::Object(fields), Some((traceparent, tracestate))) =
                (&mut payload, telemetry::active_trace())
            {
                let mut carrier = Map::new();
                carrier.insert("traceparent".to_owned(), json!(traceparent));
                if let Some(state) = tracestate {
                    carrier.insert("tracestate".to_owned(), json!(state));
                }
                fields.insert("_trace".to_owned(), Value::Object(carrier));
            }
            let mut data = Map::new();
            data.insert("channel".to_owned(), json!(channel));
            if let Some(cid) = &correlation_id {
                data.insert("correlationId".to_owned(), json!(cid));
            }
            bus_log(
                "SSE",
                &channel,
                &payload,
                scope.as_deref(),
                correlation_id.as_deref(),
            );
            data.insert("payload".to_owned(), payload);
            if let Some(scope) = &scope {
                data.insert("scope".to_owned(), json!(scope));
            }
            self.write("bus-event", &Value::Object(data).to_string(), Some(&id));
        };
        match correlation_id.as_deref().filter(|c| !c.is_empty()) {
            Some(cid) => {
                let mut attributes = vec![
                    KeyValue::new("bus.channel", channel.clone()),
                    KeyValue::new("bus.cid", cid.to_owned()),
                ];
                if let Some(scope) = &scope {
                    attributes.push(KeyValue::new("bus.scope", scope.clone()));
                }
                telemetry::in_span_now(
                    format!("sse.deliver:{channel}"),
                    SpanKind::Producer,
                    attributes,
                    &parent,
                    write,
                );
            }
            None => {
                let _attached = parent.attach();
                write();
            }
        }
    }

    /// A live frame: buffered while a replay runs — the replay abandoned when
    /// too many outrun it — and delivered otherwise.
    fn arrive(self: &Arc<Self>, frame: Queued) {
        let mut delivery = locked(&self.delivery);
        if !delivery.buffering {
            self.deliver(&mut delivery, frame);
            return;
        }
        if delivery.buffer.len() >= self.limits.replay_buffer_events {
            drop(delivery);
            logging::warn(
                "SSE replay-buffer overflow — disconnecting stalled subscriber",
                bus(json!({ "connectionId": self.id, "cap": self.limits.replay_buffer_events })),
            );
            self.teardown("replay-buffer-overflow");
            return;
        }
        delivery.buffer.push(frame);
    }

    fn resume_gap(self: &Arc<Self>, reason: &str, scope: &str, last_seen_id: &str) {
        telemetry::record_resume_gap(reason);
        let data = json!({ "channel": "bus:resume-gap", "payload": { "reason": reason, "scope": scope, "lastSeenId": last_seen_id } });
        let id = self.next_ephemeral();
        let _delivery = locked(&self.delivery);
        self.write("bus-event", &data.to_string(), Some(&id));
    }

    async fn announce(app: Arc<App>, channel: &'static str, did: String, connection_id: String) {
        let presence = json!({ "participant": did, "connectionId": connection_id });
        if app
            .bus
            .plane
            .ingest(channel.to_owned(), presence, None, None)
            .await
            .is_err()
        {
            logging::warn(
                "[bus PRESENCE-DROPPED] the signal plane could not carry a presence frame",
                bus(json!({ "channel": channel, "connectionId": connection_id })),
            );
        }
    }

    /// One teardown, whichever detector notices first: the client gone, or a bound crossed.
    fn teardown(self: &Arc<Self>, reason: &str) {
        if self.torn_down.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(subscription) = locked(&self.subscription).take() {
            subscription.close();
        }
        self.gate.close();
        telemetry::subscriber_disconnected();
        tokio::spawn(Self::announce(
            self.app.clone(),
            "session:left",
            self.did.clone(),
            self.id.clone(),
        ));
        let pending = {
            let mut outbox = locked(&self.outbox);
            outbox.queue.clear();
            if let Some(waker) = outbox.waker.take() {
                waker.wake();
            }
            std::mem::take(&mut outbox.pending)
        };
        logging::info(
            "SSE disconnect",
            bus(json!({ "connectionId": self.id, "reason": reason, "pendingBytes": pending })),
        );
        self.ended.notify_one();
        self.abort.abort();
    }

    async fn run(
        self: Arc<Self>,
        global: Vec<String>,
        scoped: Vec<Scoped>,
        pending_replies: Vec<String>,
    ) {
        logging::info(
            "SSE subscribe",
            bus(json!({
                "connectionId": self.id,
                "channels": global,
                "scopes": scoped.iter().map(|s| json!({ "scope": s.scope, "channels": s.channels, "lastEventId": s.last_event_id })).collect::<Vec<_>>(),
            })),
        );
        telemetry::subscriber_connected();
        Self::announce(
            self.app.clone(),
            "session:joined",
            self.did.clone(),
            self.id.clone(),
        )
        .await;

        let connection = self.clone();
        let on_frame = Arc::new(move |frame: Frame| {
            let correlation_id = frame
                .meta
                .as_ref()
                .and_then(|m| m.get("correlationId"))
                .cloned();
            let trace = trace_of(frame.meta.as_ref());
            let queued = Queued {
                channel: frame.channel.clone(),
                payload: frame.payload,
                scope: frame.scope.clone(),
                correlation_id: correlation_id.clone(),
                trace,
            };
            if frame.scope.is_none() && spec().is_correlated(&frame.channel) {
                let target = connection.clone();
                connection.gate.offer(
                    &frame.channel,
                    correlation_id.as_deref(),
                    Box::new(move || target.arrive(queued)),
                );
            } else {
                connection.arrive(queued);
            }
        });
        let subscribed = self
            .app
            .bus
            .plane
            .subscribe_client(ClientSubscription {
                global,
                scoped: scoped
                    .iter()
                    .map(|s| ScopedChannels {
                        scope: s.scope.clone(),
                        channels: s.channels.clone(),
                    })
                    .collect(),
                on_frame,
            })
            .await;
        match subscribed {
            Ok(subscription) => {
                if self.torn_down() {
                    subscription.close();
                } else {
                    *locked(&self.subscription) = Some(subscription);
                }
            }
            Err(error) => {
                logging::error(
                    "the signal plane refused a subscription",
                    bus(json!({ "connectionId": self.id, "error": error })),
                );
                self.teardown("subscribe-failed");
                return;
            }
        }

        // Each watermarked scope replays on its own; a watermark that cannot
        // be honoured gaps only its own scope.
        for entry in &scoped {
            if self.torn_down() {
                break;
            }
            let Some(last) = &entry.last_event_id else {
                continue;
            };
            match parse_persisted(last) {
                None => self.resume_gap("unparseable-last-event-id", &entry.scope, last),
                Some((scope, _)) if scope != entry.scope => {
                    self.resume_gap("scope-mismatch", &entry.scope, last)
                }
                Some((_, sequence)) => {
                    match self.app.archivist.replay(&entry.scope, sequence + 1).await {
                        Ok(events) => {
                            if events
                                .first()
                                .and_then(sequence_of)
                                .is_some_and(|first| first > sequence + 1)
                            {
                                self.resume_gap("retention-exceeded", &entry.scope, last);
                            }
                            let mut delivery = locked(&self.delivery);
                            for event in events {
                                let Some(kind) = event["type"].as_str().map(str::to_owned) else {
                                    continue;
                                };
                                if entry.channels.contains(&kind) {
                                    let frame = Queued {
                                        channel: kind,
                                        payload: Arc::new(event),
                                        scope: Some(entry.scope.clone()),
                                        correlation_id: None,
                                        trace: None,
                                    };
                                    self.deliver(&mut delivery, frame);
                                }
                            }
                        }
                        Err(error) => {
                            logging::warn(
                                "bus resume query failed",
                                bus(
                                    json!({ "scope": entry.scope, "fromSequence": sequence + 1, "error": error }),
                                ),
                            );
                            self.resume_gap("query-error", &entry.scope, last);
                        }
                    }
                }
            }
        }

        // Replies retained while this client was away, to their owner only.
        for cid in &pending_replies {
            if self.torn_down() {
                break;
            }
            if let Some(reply) = self
                .app
                .bus
                .ledger
                .lookup_reply(cid, &self.client_id, Some(&self.did))
                .await
            {
                let frame = Queued {
                    channel: reply.channel,
                    payload: Arc::new(reply.payload),
                    scope: None,
                    correlation_id: Some(reply.correlation_id),
                    trace: None,
                };
                let mut delivery = locked(&self.delivery);
                self.deliver(&mut delivery, frame);
            }
        }

        {
            let mut delivery = locked(&self.delivery);
            for frame in std::mem::take(&mut delivery.buffer) {
                self.deliver(&mut delivery, frame);
            }
            delivery.buffering = false;
        }

        let heartbeat = Duration::from_secs(self.limits.heartbeat_seconds);
        while !self.torn_down() {
            self.write("ping", "", None);
            tokio::select! {
                () = tokio::time::sleep(heartbeat) => {}
                () = self.ended.notified() => {}
            }
        }
    }
}
