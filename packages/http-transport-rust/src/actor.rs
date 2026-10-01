//! The stream (docs/protocol/TRANSPORT-HTTP.md § The client): one task that
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
use crate::transport::{Shared, locked};
use futures::StreamExt;
use semiont::bus_log::{bus_log, bus_note};
use semiont::channels::RESOURCE_SCOPED_CHANNELS;
use semiont::errors::TransportError;
use semiont::retry::{equal_jitter, retry_after};
use semiont::timing::{DEGRADED_THRESHOLD, MAX_RECONNECT, RECONNECT_DEBOUNCE};
use semiont::transport::{ConnectionState, Envelope, Frame, TraceCarrier};
use semiont::types::{BusSubscribeRequest, BusSubscribeRequestScopedItem};
use semiont_observability::telemetry;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

/// Where a frame's payload carries the trace it was sent under.
const TRACE_FIELD: &str = "_trace";

pub(crate) enum Command {
    /// A resource's scope got its first hold.
    AddScope(String),
    /// A resource's scope lost its last hold.
    RemoveScope(String),
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
    scoped: BTreeMap<String, Vec<String>>,
    /// The last recorded event delivered on each scope. A scope keeps its
    /// position after it is let go: taken again, it resumes from there.
    watermarks: HashMap<String, String>,
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
        equal_jitter(cap)
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
        // Read by what it means: a frame a later gateway adds a field to is
        // still a frame. One that is not a frame at all is not delivered.
        let Ok(Value::Object(mut frame)) = serde_json::from_str::<Value>(data) else {
            return;
        };
        let (Some(Value::String(channel)), Some(Value::Object(mut payload))) =
            (frame.remove("channel"), frame.remove("payload"))
        else {
            return;
        };
        let text = |value: Option<Value>| match value {
            Some(Value::String(text)) => Some(text),
            _ => None,
        };
        let correlation_id = text(frame.remove("correlationId"));
        let scope = text(frame.remove("scope"));
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
            trace: telemetry::received(&channel, scope.as_deref(), trace),
            channel,
            payload,
            correlation_id,
            scope,
        };

        self.shared.router.route(&frame);
        if self.shared.global.contains(&frame.channel)
            || RESOURCE_SCOPED_CHANNELS.contains(&frame.channel.as_str())
        {
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
        // only a recorded event's id (`p-…`) is one, and it always comes on
        // its scope.
        if let (Some(id), Some(scope)) = (&id, &frame.scope)
            && id.starts_with("p-")
        {
            self.watermarks.insert(scope.clone(), id.clone());
        }
        self.shared.hub.deliver(frame);
    }

    fn refused(&mut self, conn: u64, error: TransportError) {
        let Some(connection) = self.connections.remove(&conn) else {
            return;
        };
        self.settle_connect(conn, false);
        // A refused connect is a request the gateway refused, reported as
        // one. A connect that got no answer is not: it is a state.
        let stated_wait = error.retry_after;
        let status = error.status;
        self.shared.failed(error);
        let superseded = self.superseded.remove(&conn);
        if status == Some(401) && self.running && !superseded {
            // Sending this token again gets the same answer, so it is not
            // sent again: the client waits for a different one, and asks its
            // refresher for one once per outage.
            self.refused_token = Some(connection.token);
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
                    tokio::spawn(async move {
                        let token = refresher.refresh().await;
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
    let response = shared
        .http
        .post(format!("{}/bus/subscribe", shared.base_url))
        .bearer_auth(&token)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .json(&body)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(_) => {
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
        let error =
            TransportError::of_status(format!("SSE connect failed: {status}"), status, stated_wait);
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
    let mut actor = Actor {
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
        watermarks: HashMap::new(),
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
    };
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
}
