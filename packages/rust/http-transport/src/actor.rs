//! The stream (protocol/contract/TRANSPORT-HTTP.md § The client): one task that
//! owns the subscription, the connections that carry it, and the state they
//! add up to.
//!
//! A client holds one live stream. Two things replace it, and they are
//! different things:
//!
//! - A **drop**: the stream ended, or a connect failed with none live. For a
//!   while frames are not delivered, the state leaves `Open`, and the stream
//!   is opened again on a backoff, naming each scope's last position and the
//!   replies still awaited.
//! - A **handoff**: the subscription changed. A second connection is opened
//!   beside the live one and takes over once it is open; the old one keeps
//!   being read for `linger` and is closed then. Nothing is missed, so the
//!   state stays `Open`.
//!
//! While both connections of a handoff are read, a frame with an identity of
//! its own is delivered once: the ids of the last frames delivered are
//! remembered, and a frame whose id is among them is dropped.
//!
//! Connections are tasks that only read; everything they read comes back to
//! this one task in order, so the state machine has no locks and no races.

use crate::sse::SseParser;
use crate::transport::{MALFORMED, Shared, gateway_words, locked, refusal};
use futures::StreamExt;
use semiont::bus_log::{bus_log, bus_note};
use semiont::channels::{RESOURCE_SCOPED_CHANNELS, TRACE_FIELD};
use semiont::errors::{TransportError, TransportErrorCode};
use semiont::resume::is_persisted_event_id;
use semiont::retry::{equal_jitter, retry_after};
use semiont::timing::{DEGRADED_THRESHOLD, MAX_RECONNECT, RECONNECT_DEBOUNCE};
use semiont::transport::{ConnectionState, Envelope, Frame, FrameRefusal, TraceCarrier};
use semiont::types::ResourceId;
use semiont::types::{BusFrame, BusSubscribeRequest, BusSubscribeRequestScopedItem};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

pub(crate) enum Command {
    /// A resource's scope got its first hold.
    AddScope(ResourceId),
    /// A resource's scope lost its last hold.
    RemoveScope(ResourceId),
    Close(oneshot::Sender<()>),
}

/// What a connection, or the renewal of a token, reports to the stream's task.
enum Event {
    /// The subscribe response is streaming.
    Opened { conn: u64 },
    /// An event of the stream, with the id it came under.
    Frame {
        conn: u64,
        id: Option<String>,
        data: String,
    },
    /// The gateway answered the connect, and not with a stream.
    Refused { conn: u64, error: TransportError },
    /// The connect got no answer, or the stream ended.
    Ended { conn: u64 },
    /// The refresher answered: the renewed token, or none.
    Renewed {
        token: Option<String>,
        keep_previous: bool,
    },
}

struct Connection {
    task: tokio::task::JoinHandle<()>,
    /// The token the connect sent: what is remembered if it is refused.
    token: String,
    /// Whether it was opened beside a live stream, to take over from it.
    keep_previous: bool,
    /// The connections it retires once it is open.
    previous: Vec<u64>,
}

/// The ids of the frames delivered last.
struct SeenIds {
    order: VecDeque<String>,
    ids: HashSet<String>,
    capacity: usize,
}

impl SeenIds {
    /// Remember `id`; `false` when it was already remembered.
    fn remember(&mut self, id: &str) -> bool {
        if self.ids.contains(id) {
            return false;
        }
        self.ids.insert(id.to_owned());
        self.order.push_back(id.to_owned());
        if self.order.len() > self.capacity
            && let Some(oldest) = self.order.pop_front()
        {
            self.ids.remove(&oldest);
        }
        true
    }
}

struct Actor {
    shared: Arc<Shared>,
    state: watch::Sender<ConnectionState>,
    events: mpsc::Sender<Event>,
    running: bool,

    /// The subscription's scoped half: each scope held, and its channels.
    scoped: BTreeMap<ResourceId, Vec<String>>,
    /// The last recorded event delivered on each scope. A scope keeps its
    /// position after it is let go: taken again, it resumes from there.
    watermarks: HashMap<ResourceId, String>,
    seen: SeenIds,

    next_conn: u64,
    connections: HashMap<u64, Connection>,
    /// The connection whose stream is the client's own. While there is one
    /// the state is `Open`.
    live: Option<u64>,
    /// The connect not yet answered. Changes of subscription asked for
    /// meanwhile are served by one follow-up once it opens.
    connecting: Option<u64>,
    reconnect_owed: bool,
    /// Connections a handoff retired: still read, until their linger ends.
    superseded: HashSet<u64>,
    lingering: Vec<(Instant, Vec<u64>)>,

    /// How many connects have failed since the last open.
    retry_attempt: u32,
    /// The token the gateway refused: never sent again.
    refused_token: Option<String>,
    /// One renewal per outage; a successful open re-arms it.
    refresh_burned: bool,
    /// Waiting for a credential, with nothing to send until one comes.
    awaiting_credential: bool,

    retry_at: Option<(Instant, bool)>,
    debounce_at: Option<Instant>,
    lazy_at: Option<Instant>,
    degraded_at: Option<Instant>,
}

/// The transitions the connection's state may make.
fn allowed(from: ConnectionState, to: ConnectionState) -> bool {
    use ConnectionState::*;
    match from {
        Initial => matches!(to, Connecting | Unauthenticated | Closed),
        Connecting => matches!(to, Open | Reconnecting | Unauthenticated | Closed),
        Open => matches!(to, Reconnecting | Closed),
        Reconnecting => matches!(to, Connecting | Degraded | Unauthenticated | Closed),
        Degraded => matches!(to, Connecting | Unauthenticated | Closed),
        Unauthenticated => matches!(to, Connecting | Closed),
        Closed => false,
    }
}

impl Actor {
    /// The stream's task, not yet running, each scope to begin at its place
    /// in `watermarks`.
    fn new(
        shared: Arc<Shared>,
        state: watch::Sender<ConnectionState>,
        events: mpsc::Sender<Event>,
        watermarks: HashMap<ResourceId, String>,
    ) -> Actor {
        Actor {
            seen: SeenIds {
                order: VecDeque::new(),
                ids: HashSet::new(),
                capacity: shared.timing.seen_event_ids,
            },
            shared,
            state,
            events,
            running: false,
            scoped: BTreeMap::new(),
            watermarks,
            next_conn: 0,
            connections: HashMap::new(),
            live: None,
            connecting: None,
            reconnect_owed: false,
            superseded: HashSet::new(),
            lingering: Vec::new(),
            retry_attempt: 0,
            refused_token: None,
            refresh_burned: false,
            awaiting_credential: false,
            retry_at: None,
            debounce_at: None,
            lazy_at: None,
            degraded_at: None,
        }
    }

    fn state(&self) -> ConnectionState {
        *self.state.borrow()
    }

    fn transition(&mut self, next: ConnectionState) {
        let current = self.state();
        if current == next || !allowed(current, next) {
            return;
        }
        // A stream that stays down is degraded once it has been reconnecting
        // for the threshold: the timer runs while the state is `Reconnecting`.
        self.degraded_at =
            (next == ConnectionState::Reconnecting).then(|| Instant::now() + DEGRADED_THRESHOLD);
        self.state.send_replace(next);
    }

    fn schedule_retry(&mut self, after: Duration, keep_previous: bool) {
        if self.running {
            self.retry_at = Some((Instant::now() + after, keep_previous));
        }
    }

    /// Equal-jitter exponential backoff: a wait in [cap/2, cap], where cap is
    /// `reconnect` doubled per failure up to `MAX_RECONNECT`.
    fn backoff(&mut self) -> Duration {
        let cap = self
            .shared
            .timing
            .reconnect
            .saturating_mul(2u32.saturating_pow(self.retry_attempt))
            .min(MAX_RECONNECT);
        self.retry_attempt = self.retry_attempt.saturating_add(1);
        equal_jitter(cap, self.shared.random.as_deref())
    }

    fn abort(&mut self, conn: u64) {
        if let Some(connection) = self.connections.remove(&conn) {
            connection.task.abort();
        }
        self.superseded.remove(&conn);
    }

    fn connect(&mut self, keep_previous: bool) {
        // A connect with no token cannot succeed, and neither can one that
        // sends again the token the gateway just refused. Neither is
        // attempted: the client waits, with no request, for a different one.
        let token = self.shared.current_token();
        let Some(token) = token.filter(|token| self.refused_token.as_ref() != Some(token)) else {
            if self.running {
                // With a stream still live the state stays `Open`: only the
                // change of subscription is waiting for a credential.
                if self.live.is_none() {
                    self.transition(ConnectionState::Unauthenticated);
                }
                self.awaiting_credential = true;
                self.schedule_retry(self.shared.timing.reconnect, keep_previous);
            }
            return;
        };
        self.refused_token = None;
        self.awaiting_credential = false;

        let previous: Vec<u64> = self.connections.keys().copied().collect();
        if !keep_previous {
            // An initial connect, or the recovery of a drop: nothing live is
            // worth keeping.
            for conn in &previous {
                self.abort(*conn);
            }
            self.live = None;
            self.lingering.clear();
        }
        // Opening beside a live stream is a handoff, and the state stays
        // `Open`. With none, this is `Connecting`.
        if self.live.is_none() {
            self.transition(ConnectionState::Connecting);
        }

        let awaited = self.shared.router.awaited();
        let body = BusSubscribeRequest {
            client_id: self.shared.client_id.clone(),
            global: Some(self.shared.global.clone()),
            scoped: Some(
                self.scoped
                    .iter()
                    .map(|(scope, channels)| BusSubscribeRequestScopedItem {
                        scope: scope.clone(),
                        channels: channels.clone(),
                        last_event_id: self.watermarks.get(scope).cloned(),
                    })
                    .collect(),
            ),
            pending_replies: (!awaited.is_empty()).then_some(awaited),
        };
        let conn = self.next_conn;
        self.next_conn += 1;
        let task = tokio::spawn(connection(
            self.shared.clone(),
            conn,
            token.clone(),
            body,
            self.events.clone(),
        ));
        self.connections.insert(
            conn,
            Connection {
                task,
                token,
                keep_previous,
                previous: if keep_previous { previous } else { Vec::new() },
            },
        );
        self.connecting = Some(conn);
    }

    /// A changed subscription: hand it to a new stream. The live one is not
    /// touched, and the state does not move.
    fn reconnect(&mut self) {
        if !self.running {
            return;
        }
        if self.connecting.is_some() {
            self.reconnect_owed = true;
            return;
        }
        self.retry_at = None;
        self.connect(true);
    }

    /// The connect `conn` made is answered. Opened, it serves the changes
    /// asked for while it was in flight with one follow-up; failed, it leaves
    /// them to the retry, which reads the same subscription.
    fn settle_connect(&mut self, conn: u64, opened: bool) {
        if self.connecting != Some(conn) {
            return;
        }
        self.connecting = None;
        let owed = std::mem::take(&mut self.reconnect_owed);
        if opened && owed && self.running {
            self.reconnect();
        }
    }

    fn opened(&mut self, conn: u64) {
        let Some(connection) = self.connections.get(&conn) else {
            return;
        };
        if connection.keep_previous {
            // The new stream is established, so the ones it replaces are
            // retired by drain: read for `linger` more, then closed. Closing
            // them now would discard what they have received and not yet
            // delivered.
            let previous: Vec<u64> = connection
                .previous
                .iter()
                .copied()
                .filter(|previous| self.connections.contains_key(previous))
                .collect();
            self.superseded.extend(previous.iter().copied());
            self.lingering
                .push((Instant::now() + self.shared.timing.linger, previous));
        }
        self.live = Some(conn);
        self.transition(ConnectionState::Open);
        self.retry_attempt = 0;
        self.refresh_burned = false;
        self.settle_connect(conn, true);
    }

    fn frame(&mut self, conn: u64, id: Option<String>, data: &str) {
        if !self.connections.contains_key(&conn) {
            return;
        }
        if let Some(id) = &id
            && !self.seen.remember(id)
        {
            return;
        }
        let BusFrame {
            channel,
            correlation_id,
            mut payload,
            scope,
        } = match carried(data) {
            Line::Frame(frame) => frame,
            Line::Told(refusal) => {
                self.tell(refusal);
                return;
            }
            Line::Unread(said) => {
                self.shared.failed(TransportError::without_response(
                    format!("the stream carried what is not a frame: {said}"),
                    TransportErrorCode::Error,
                ));
                return;
            }
        };
        let trace = payload.remove(TRACE_FIELD).and_then(carrier);

        bus_log(
            "RECV",
            &channel,
            &Value::Object(payload.clone()),
            scope.as_deref(),
            correlation_id.as_deref(),
        );
        if self.superseded.contains(&conn) {
            // A frame an abort at the moment of handoff would have discarded.
            bus_note("LINGER", &channel, "delivered on superseded connection");
        }
        let frame = Frame {
            trace: semiont_telemetry::bus_recv(&channel, scope.as_deref(), trace),
            channel,
            payload,
            correlation_id,
            scope,
        };

        self.shared.router.route(Ok(&frame));
        if self.bridged(&frame.channel) {
            for bus in locked(&self.shared.bridges).iter() {
                bus.emit(
                    &frame.channel,
                    frame.payload.clone(),
                    Envelope {
                        correlation_id: frame.correlation_id.clone(),
                        scope: None,
                    },
                );
            }
        }
        // A scope's position is the last recorded event delivered on it:
        // only a recorded event's id is one, and it always comes on its
        // scope.
        if let (Some(id), Some(scope)) = (&id, &frame.scope)
            && is_persisted_event_id(id)
        {
            self.watermarks.insert(scope.clone(), id.clone());
            if let Some(bookmarks) = &self.shared.bookmarks {
                bookmarks.save(scope, id);
            }
        }
        self.shared.hub.deliver(Ok(frame));
    }

    /// Whether frames of `channel` are published into the client's own bus:
    /// those of its global channels and of every resource's scope.
    fn bridged(&self, channel: &str) -> bool {
        self.shared.global.iter().any(|global| global == channel)
            || RESOURCE_SCOPED_CHANNELS.contains(&channel)
    }

    /// A frame refused that names its readers: the request its correlation
    /// id names is told of it, as of the frame, and its refusal is delivered
    /// in its place and published into the client's own bus as the frame
    /// would have been.
    fn tell(&self, refusal: FrameRefusal) {
        self.shared.router.route(Err(&refusal));
        if self.bridged(&refusal.channel) {
            for bus in locked(&self.shared.bridges).iter() {
                bus.emit_refusal(FrameRefusal {
                    scope: None,
                    ..refusal.clone()
                });
            }
        }
        self.shared.hub.deliver(Err(refusal));
    }

    fn refused(&mut self, conn: u64, error: TransportError) {
        let Some(connection) = self.connections.remove(&conn) else {
            return;
        };
        self.settle_connect(conn, false);
        // A refused connect is a request the gateway refused, reported as
        // one. A connect that got no answer is not: it is a state.
        let stated_wait = error.retry_after;
        let credential_refused = error.code == TransportErrorCode::Unauthorized;
        self.shared.failed(error);
        let superseded = self.superseded.remove(&conn);
        if credential_refused && self.running && !superseded {
            // Sending this token again gets the same answer, so it is not
            // sent again: the client waits for a different one, and asks its
            // refresher for one once per outage.
            self.refused_token = Some(connection.token.clone());
            self.retry_attempt = 0;
            if self.live.is_none() {
                self.transition(ConnectionState::Unauthenticated);
            }
            match (&self.shared.refresher, self.refresh_burned) {
                (Some(refresher), false) => {
                    self.refresh_burned = true;
                    let refresher = refresher.clone();
                    let events = self.events.clone();
                    let keep_previous = connection.keep_previous;
                    let refused = connection.token;
                    tokio::spawn(async move {
                        let token = refresher.refresh(Some(&refused)).await;
                        let _ = events
                            .send(Event::Renewed {
                                token,
                                keep_previous,
                            })
                            .await;
                    });
                }
                _ => {
                    self.awaiting_credential = true;
                    self.schedule_retry(self.shared.timing.reconnect, connection.keep_previous);
                }
            }
            return;
        }
        self.dropped_or_failed(conn, superseded, stated_wait);
    }

    fn ended(&mut self, conn: u64) {
        if self.connections.remove(&conn).is_none() {
            return;
        }
        self.settle_connect(conn, false);
        let superseded = self.superseded.remove(&conn);
        self.dropped_or_failed(conn, superseded, None);
    }

    /// A stream ended, or a connect failed. A superseded connection ending is
    /// expected and restarts nothing.
    fn dropped_or_failed(&mut self, conn: u64, superseded: bool, stated_wait: Option<Duration>) {
        if !self.running || superseded {
            return;
        }
        if self.live.is_some() && self.live != Some(conn) {
            // A handoff that could not open. The stream it was to replace is
            // still live, so nothing has dropped: it is tried again on the
            // backoff, and the state does not move.
            let wait = self.backoff().max(stated_wait.unwrap_or_default());
            self.schedule_retry(wait, true);
            return;
        }
        // A drop.
        self.live = None;
        self.transition(ConnectionState::Reconnecting);
        if self.connecting.is_some() {
            // A handoff's connect is in flight: it is the recovery now, and
            // comes back through here if it fails.
            self.transition(ConnectionState::Connecting);
            return;
        }
        let wait = self.backoff().max(stated_wait.unwrap_or_default());
        self.schedule_retry(wait, false);
    }

    fn renewed(&mut self, token: Option<String>, keep_previous: bool) {
        if !self.running {
            return;
        }
        if token.is_some() && token != self.refused_token {
            self.schedule_retry(Duration::ZERO, keep_previous);
        } else {
            self.awaiting_credential = true;
            self.schedule_retry(self.shared.timing.reconnect, keep_previous);
        }
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::AddScope(resource) => {
                self.scoped.insert(
                    resource,
                    RESOURCE_SCOPED_CHANNELS
                        .iter()
                        .map(|channel| (*channel).to_owned())
                        .collect(),
                );
                // A new scope needs to be live now: additions are gathered
                // for the debounce, and carry any removal waiting with them.
                self.lazy_at = None;
                self.debounce_at = Some(Instant::now() + RECONNECT_DEBOUNCE);
            }
            Command::RemoveScope(resource) => {
                if self.scoped.remove(&resource).is_some()
                    && self.debounce_at.is_none()
                    && self.lazy_at.is_none()
                {
                    // A removal only narrows what is delivered, so it waits:
                    // a client that brushes past scopes would otherwise
                    // reopen its stream at each.
                    self.lazy_at = Some(Instant::now() + self.shared.timing.lazy_remove);
                }
            }
            Command::Close(_) => {}
        }
    }

    /// The token changed: a client waiting for a credential tries at once.
    fn token_changed(&mut self) {
        if !self.running {
            if self.state() == ConnectionState::Initial && self.shared.current_token().is_some() {
                self.running = true;
                self.connect(false);
            }
            return;
        }
        if self.awaiting_credential
            && let Some((_, keep_previous)) = self.retry_at
        {
            self.retry_at = Some((Instant::now(), keep_previous));
        }
    }

    fn next_deadline(&self) -> Option<Instant> {
        [
            self.retry_at.map(|(at, _)| at),
            self.debounce_at,
            self.lazy_at,
            self.degraded_at,
            self.lingering.iter().map(|(at, _)| *at).min(),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    fn timers(&mut self) {
        let now = Instant::now();
        let due = |at: Option<Instant>| at.is_some_and(|at| at <= now);
        if due(self.degraded_at) {
            self.degraded_at = None;
            if self.state() == ConnectionState::Reconnecting {
                self.state.send_replace(ConnectionState::Degraded);
            }
        }
        let (over, lingering): (Vec<_>, Vec<_>) = std::mem::take(&mut self.lingering)
            .into_iter()
            .partition(|(at, _)| *at <= now);
        self.lingering = lingering;
        for conn in over.into_iter().flat_map(|(_, conns)| conns) {
            self.abort(conn);
        }
        if due(self.debounce_at) || due(self.lazy_at) {
            self.debounce_at = None;
            self.lazy_at = None;
            self.reconnect();
        }
        if let Some((at, keep_previous)) = self.retry_at
            && at <= now
        {
            self.retry_at = None;
            if self.running {
                self.connect(keep_previous);
            }
        }
    }

    fn close(&mut self) {
        self.running = false;
        self.transition(ConnectionState::Closed);
        for conn in self.connections.keys().copied().collect::<Vec<_>>() {
            self.abort(conn);
        }
        self.live = None;
        self.connecting = None;
        self.lingering.clear();
        (
            self.retry_at,
            self.debounce_at,
            self.lazy_at,
            self.degraded_at,
        ) = (None, None, None, None);
        self.shared.hub.close();
        self.shared.router.close();
        *locked(&self.shared.failures) = None;
    }
}

/// What a line of the stream is read as.
#[derive(Debug, PartialEq)]
enum Line {
    /// A frame BusFrame allows.
    Frame(BusFrame),
    /// A frame BusFrame does not allow that names its readers: its refusal,
    /// told to them.
    Told(FrameRefusal),
    /// What names no reader, and what every SDK says of its first fault: told
    /// to the failure report.
    Unread(String),
}

/// `data` read as a frame, or as why it is not one. A frame carries what
/// BusFrame names, and nothing more. What serde refuses that the table of
/// what BusFrame requires does not is malformed itself.
fn carried(data: &str) -> Line {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return Line::Unread(MALFORMED.to_owned());
    };
    match readers_of(&value) {
        Some((channel, scope)) => match FrameRefusal::of(&value, channel, scope) {
            Some(refusal) => Line::Told(refusal),
            // BusFrame's type states no length, and its scope was read as a
            // resource's id: serde refuses nothing of a frame the table allows.
            None => match serde_json::from_value(value) {
                Ok(frame) => Line::Frame(frame),
                Err(error) => panic!("serde refused a frame BusFrame allows: {error}"),
            },
        },
        None => match semiont::fault_said::<BusFrame>(&value) {
            Some(said) => Line::Unread(said),
            None => match serde_json::from_value(value) {
                Ok(frame) => Line::Frame(frame),
                Err(_) => Line::Unread(MALFORMED.to_owned()),
            },
        },
    }
}

/// The readers `value` names: those of its `channel`, when that is a text of
/// at least one character, in its `scope`, when it carries none or one that
/// is a resource's id. Any other names no reader. A null scope is none, as
/// BusFrame's walk reads a null optional member.
fn readers_of(value: &Value) -> Option<(String, Option<ResourceId>)> {
    let channel = value.get("channel")?.as_str()?;
    if channel.is_empty() {
        return None;
    }
    let scope = match value.get("scope") {
        None | Some(Value::Null) => None,
        Some(Value::String(scope)) => Some(scope.parse().ok()?),
        Some(_) => return None,
    };
    Some((channel.to_owned(), scope))
}

fn carrier(value: Value) -> Option<TraceCarrier> {
    Some(TraceCarrier {
        traceparent: value.get("traceparent")?.as_str()?.to_owned(),
        tracestate: value
            .get("tracestate")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// One connection: the subscribe request, and every event its stream
/// carries, reported to the stream's task in order.
async fn connection(
    shared: Arc<Shared>,
    conn: u64,
    token: String,
    body: BusSubscribeRequest,
    events: mpsc::Sender<Event>,
) {
    let request = shared
        .http
        .post(format!("{}/bus/subscribe", shared.base_url))
        .bearer_auth(&token)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .json(&body)
        .send();
    let response = match tokio::time::timeout(shared.timing.stream_open, request).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) | Err(_) => {
            let _ = events.send(Event::Ended { conn }).await;
            return;
        }
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let stated_wait = retry_after(
            response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
        );
        // A refusal's body is read within the request deadline, as any other
        // answer is: one not read by then is a refusal that says nothing.
        let said = tokio::time::timeout(shared.timing.http_request, response.json::<Value>())
            .await
            .ok()
            .and_then(Result::ok);
        let message = match gateway_words(said.as_ref()) {
            Some(words) => format!("SSE connect failed: {status}: {words}"),
            None => format!("SSE connect failed: {status}"),
        };
        let error = refusal(message, status, stated_wait, said.as_ref());
        let _ = events.send(Event::Refused { conn, error }).await;
        return;
    }
    if events.send(Event::Opened { conn }).await.is_err() {
        return;
    }
    let mut parser = SseParser::new();
    let mut body = response.bytes_stream();
    while let Some(Ok(read)) = body.next().await {
        for event in parser.feed(&read) {
            if event.event != "bus-event" || event.data.is_empty() {
                continue;
            }
            let frame = Event::Frame {
                conn,
                id: event.id,
                data: event.data,
            };
            if events.send(frame).await.is_err() {
                return;
            }
        }
    }
    let _ = events.send(Event::Ended { conn }).await;
}

/// Hold the client's stream until it is closed, or nothing holds the
/// transport any more.
pub(crate) async fn run(
    shared: Arc<Shared>,
    state: watch::Sender<ConnectionState>,
    mut commands: mpsc::UnboundedReceiver<Command>,
) {
    let (events, mut reported) = mpsc::channel(256);
    let mut token = shared.token.clone();
    // Each scope begins where the client's last life left it, when that
    // was kept.
    let watermarks = shared
        .bookmarks
        .as_ref()
        .map(|bookmarks| bookmarks.load())
        .unwrap_or_default();
    let mut actor = Actor::new(shared, state, events, watermarks);
    // The stream starts when there is a token to open it with.
    token.borrow_and_update();
    actor.token_changed();
    let mut token_source_live = true;
    loop {
        let deadline = actor.next_deadline();
        tokio::select! {
            command = commands.recv() => match command {
                Some(Command::Close(done)) => {
                    actor.close();
                    let _ = done.send(());
                    return;
                }
                Some(command) => actor.command(command),
                None => {
                    actor.close();
                    return;
                }
            },
            Some(event) = reported.recv() => match event {
                Event::Opened { conn } => actor.opened(conn),
                Event::Frame { conn, id, data } => actor.frame(conn, id, &data),
                Event::Refused { conn, error } => actor.refused(conn, error),
                Event::Ended { conn } => actor.ended(conn),
                Event::Renewed { token, keep_previous } => actor.renewed(token, keep_previous),
            },
            changed = token.changed(), if token_source_live => match changed {
                Ok(()) => actor.token_changed(),
                Err(_) => token_source_live = false,
            },
            () = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            } => actor.timers(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::{HttpTransportConfig, Timing};
    use futures::{FutureExt, Stream};
    use semiont::bus::StreamError;
    use semiont::channels::{BeckonFocus, BrowseResourceRequested, Channel, Request};
    use semiont::event_bus::EventBus;
    use semiont::transport::{Events, FrameRefusalReason, Lagged};
    use serde_json::json;

    #[test]
    fn the_ids_remembered_are_the_last_ones_delivered() {
        let mut seen = SeenIds {
            order: VecDeque::new(),
            ids: HashSet::new(),
            capacity: 3,
        };
        for id in ["a", "b", "c"] {
            assert!(seen.remember(id));
        }
        assert!(
            !seen.remember("a"),
            "a frame delivered is not delivered again"
        );
        assert!(seen.remember("d"));
        assert!(seen.remember("a"), "the oldest has been forgotten");
        assert!(!seen.remember("c"));
    }

    #[test]
    fn open_is_left_only_for_a_drop_or_a_close() {
        use ConnectionState::*;
        for to in [Initial, Connecting, Degraded, Unauthenticated] {
            assert!(!allowed(Open, to), "{to:?}");
        }
        assert!(allowed(Open, Reconnecting));
        assert!(allowed(Open, Closed));
        for to in [
            Initial,
            Connecting,
            Open,
            Reconnecting,
            Degraded,
            Unauthenticated,
        ] {
            assert!(!allowed(Closed, to), "closed is terminal");
        }
    }

    /// The channel every case of the table told to its readers is on, but a
    /// request's, read here by type.
    const READ: &str = "beckon:focus";
    /// The correlation id a request's case names its request's by.
    const AWAITED: &str = "c-1";

    /// What `stream` has been given so far. Each line is carried before it
    /// is read, and carrying one delivers what it carries before it returns.
    fn given<S: Stream + Unpin>(stream: &mut S) -> Vec<S::Item> {
        let mut given = Vec::new();
        while let Some(Some(item)) = stream.next().now_or_never() {
            given.push(item);
        }
        given
    }

    /// A transport's shared parts, as `HttpTransport::new` makes them.
    fn shared() -> Arc<Shared> {
        // Already installed by another test of this process: one is enough.
        let _ = rustls::crypto::ring::default_provider().install_default();
        Arc::new(Shared::new(HttpTransportConfig {
            base_url: "http://gateway.test".to_owned(),
            token: watch::channel(None).1,
            refresher: None,
            channels: None,
            http: reqwest::Client::new(),
            timing: Timing::default(),
            bookmarks: None,
            random: None,
        }))
    }

    /// The stream's task over `shared`, reading its live connection, 0.
    fn reading(shared: Arc<Shared>) -> Actor {
        let mut actor = Actor::new(
            shared,
            watch::channel(ConnectionState::Open).0,
            mpsc::channel(1).0,
            HashMap::new(),
        );
        actor.connections.insert(
            0,
            Connection {
                task: tokio::spawn(async {}),
                token: String::new(),
                keep_previous: false,
                previous: Vec::new(),
            },
        );
        actor.live = Some(0);
        actor
    }

    /// Each line of protocol/specs/src/bus/frame-cases.json, the table every
    /// SDK's stream reader runs, carried on the stream with a frame of
    /// `beckon:focus` after it: what the transport delivers, what a typed
    /// read of the case's channel on the client's own bus is given, what the
    /// failure report is told and what becomes of a request awaiting the
    /// case's reply are each held to the case, and the frame after it is
    /// delivered, so the stream is seen to go on.
    #[tokio::test]
    async fn each_line_of_the_table_is_delivered_or_refused_as_it_states() {
        let table: Value = serde_json::from_str(include_str!(
            "../../../../protocol/specs/src/bus/frame-cases.json"
        ))
        .expect("the table is JSON");
        let cases = table["cases"].as_array().expect("the table has cases");
        assert!(!cases.is_empty(), "the table was not read");
        let after = json!({ "channel": READ, "payload": { "resourceId": "after" } });
        let is_after = |item: &Result<Result<Frame, FrameRefusal>, Lagged>| matches!(item, Ok(Ok(frame)) if frame.payload.get("resourceId") == Some(&json!("after")));
        type Reply = <BrowseResourceRequested as Request>::Result;
        type Failure = <BrowseResourceRequested as Request>::Failure;
        for case in cases {
            let why = case["why"].as_str().expect("a case says why");
            let frame = &case["frame"];
            let shared = shared();
            let own = Arc::new(EventBus::new());
            locked(&shared.bridges).push(own.clone());
            let mut failures = Events::new(
                locked(&shared.failures)
                    .as_mut()
                    .expect("the error stream is open")
                    .listen(),
            );
            let line = match case["data"].as_str() {
                Some(data) => data.to_owned(),
                None => frame.to_string(),
            };

            if case["refused"] != true {
                let on = frame["channel"]
                    .as_str()
                    .expect("a frame delivered names its channel");
                let mut delivered = shared.hub.frames(on);
                let mut actor = reading(shared.clone());
                actor.frame(0, None, &line);
                let Some(Ok(Ok(read))) = delivered.next().await else {
                    panic!("{why}: not delivered");
                };
                assert_eq!(
                    (
                        read.channel.as_str(),
                        Value::Object(read.payload),
                        read.correlation_id.as_deref(),
                        read.scope.as_deref(),
                    ),
                    (
                        on,
                        frame["payload"].clone(),
                        frame["correlationId"].as_str(),
                        frame["scope"].as_str(),
                    ),
                    "{why}"
                );
                assert!(
                    failures.next().now_or_never().is_none(),
                    "{why}: told to the failure report"
                );
                continue;
            }

            let member = case["member"]
                .as_str()
                .expect("a refused case names a member");
            let reason: FrameRefusalReason = serde_json::from_value(case["reason"].clone())
                .unwrap_or_else(|error| panic!("{why}: {error}"));
            let said = match reason {
                FrameRefusalReason::Lacks => format!("it has no `{member}`"),
                FrameRefusalReason::Malformed if member.is_empty() => MALFORMED.to_owned(),
                FrameRefusalReason::Malformed => format!("its `{member}` is malformed"),
            };
            // A refusal told to its readers is told to its channel's; one
            // told to nobody is looked for on `beckon:focus`.
            let on = match case["told"].as_str() {
                Some("readers") => frame["channel"]
                    .as_str()
                    .expect("a refusal told to its readers names its channel"),
                _ => READ,
            };
            let mut delivered = shared.hub.frames(on);
            let mut went_on = shared.hub.frames(READ);
            let mut focus = own.stream::<BeckonFocus>();
            let mut replies = own.stream::<Reply>();
            let pending = case
                .get("request")
                .map(|_| shared.router.track(AWAITED, &[Reply::NAME, Failure::NAME]));
            let mut actor = reading(shared.clone());
            actor.frame(0, None, &line);
            actor.frame(0, None, &after.to_string());

            assert!(
                given(&mut went_on).last().is_some_and(is_after),
                "{why}: the stream did not go on past it"
            );
            let carried: Vec<_> = given(&mut delivered)
                .into_iter()
                .filter(|item| !is_after(item))
                .collect();
            let heard: Vec<StreamError> = match on {
                READ => given(&mut focus)
                    .into_iter()
                    .filter_map(|read| match read {
                        Ok(focus) if &*focus.payload.resource_id == "after" => None,
                        Ok(focus) => panic!("{why}: a typed read gave {:?}", focus.payload),
                        Err(refused) => Some(refused),
                    })
                    .collect(),
                _ => given(&mut replies)
                    .into_iter()
                    .map(|read| match read {
                        Ok(_) => panic!("{why}: a typed read of {on} gave a reply"),
                        Err(refused) => refused,
                    })
                    .collect(),
            };
            // As the client's own bus is given it, which knows no scope.
            let refusal = FrameRefusal {
                channel: on.to_owned(),
                member: member.to_owned(),
                reason,
                payload: frame.get("payload").cloned(),
                scope: None,
                correlation_id: case["correlationId"].as_str().map(str::to_owned),
            };
            // As the transport delivers it to the readers a frame names,
            // whose scope is none or a resource's id.
            let delivered = || FrameRefusal {
                scope: frame["scope"]
                    .as_str()
                    .map(|scope| scope.parse().expect("a scope told is an id")),
                ..refusal.clone()
            };

            match case["told"].as_str() {
                Some("readers") => {
                    // A fault within the payload is its channel's to find:
                    // BusFrame takes any object for a payload, and the
                    // stream delivers the frame.
                    if member.starts_with("payload.") {
                        assert!(
                            matches!(carried.as_slice(), [Ok(Ok(_))]),
                            "{why}: {carried:?}"
                        );
                    } else {
                        assert_eq!(carried, [Ok(Err(delivered()))], "{why}");
                    }
                    assert_eq!(
                        heard,
                        [StreamError::Refused(Box::new(refusal.clone()))],
                        "{why}"
                    );
                    assert_eq!(
                        refusal.to_string(),
                        format!("a frame on {on} is not that channel's: {said}"),
                        "{why}"
                    );
                    assert!(
                        failures.next().now_or_never().is_none(),
                        "{why}: told to the failure report as well"
                    );
                }
                Some("failure-report") => {
                    assert!(carried.is_empty(), "{why}: delivered {carried:?}");
                    assert!(heard.is_empty(), "{why}: a typed read heard {heard:?}");
                    let Some(Some(Ok(report))) = failures.next().now_or_never() else {
                        panic!("{why}: the failure report was not told");
                    };
                    assert_eq!(
                        (report.code, report.status, report.message),
                        (
                            TransportErrorCode::Error,
                            None,
                            format!("the stream carried what is not a frame: {said}")
                        ),
                        "{why}"
                    );
                }
                told => panic!("{why}: told to whom the table does not give: {told:?}"),
            }

            match (case["request"].as_str(), pending) {
                (Some("fails"), Some(mut pending)) => assert_eq!(
                    pending.frame().now_or_never(),
                    Some(Some(Err(delivered()))),
                    "{why}: the request was not told of the refusal"
                ),
                (Some("waits"), Some(mut pending)) => assert_eq!(
                    pending.frame().now_or_never(),
                    None,
                    "{why}: the request was told"
                ),
                (None, None) => {}
                (request, _) => panic!("{why}: a request the table does not give: {request:?}"),
            }
        }
    }
}
