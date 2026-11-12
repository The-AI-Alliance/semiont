//! A scriptable `Transport` with no wire, for tests. Two things are scripted,
//! and they are different things: the **wire**, by a schedule of faults
//! applied one to each request in turn (deliver its reply, drop it, delay it,
//! deliver it twice, or refuse the emit); and the **gateway**, by the
//! responses queued for each operation. So "the first reply is lost and the
//! retry sees the next page" is expressible: a dropped reply still consumes
//! its queued response, because the gateway answered and the wire ate it.
//!
//! A request can be scripted to be answered with a failure (`refuse_when`):
//! the answer a peer gives when it will not do what was asked. That is not
//! the wire failing, and the schedule applies to it as to any reply.
//!
//! A request nobody scripted a response for is refused, naming the
//! operation. A double that answered it with an empty success would hand its
//! caller a reply whose every field is absent, which fails far from its
//! cause.
//!
//! Its stream names the global channels it is given, as a wire transport's
//! does, and carries a frame of one of them, or of a resource's channel on a
//! scope it holds, and nothing else. A full client's stream names
//! `BRIDGED_CHANNELS`; a worker's names the channels it claims and commits by.
//!
//! All of its variation comes in through the schedule, so a test that fixes
//! the schedule fixes the run.

use crate::bus::{operation, reply_names};
use crate::channels::{RESOURCE_SCOPED_CHANNELS, TRACE_FIELD};
use crate::errors::{BusRequestError, BusRequestErrorCode, TransportError, TransportErrorCode};
use crate::event_bus::EventBus;
use crate::locked;
use crate::transport::{
    BoxFuture, ConnectionState, Envelope, Events, FailureListener, FailureStream, Failures, Frame,
    FrameHub, FrameRefusal, Frames, PendingReply, ReplyRouter, ResourceHold, StreamId, Transport,
};
use crate::types::ResourceId;
use serde_json::{Map, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, watch};

/// What the wire does to one request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultAction {
    /// Its reply is delivered.
    Deliver,
    /// Its reply is lost.
    DropReply,
    /// Its reply is delivered after this long.
    Delay(Duration),
    /// Its reply is delivered twice.
    DuplicateReply,
    /// The emit itself is refused: the request never reaches the gateway.
    RejectEmit,
}

/// One request the transport was sent, in the order they came.
#[derive(Debug, Clone, PartialEq)]
pub struct RequestLogEntry {
    pub channel: String,
    /// What the schedule did to it.
    pub action: FaultAction,
    pub correlation_id: Option<String>,
    /// The request's identity across retries: two entries with the same key
    /// are one logical request, sent again.
    pub retry_key: String,
    /// The payload as it was sent.
    pub payload: Map<String, Value>,
}

/// A request's identity across retries: its channel and its payload, less
/// what the gateway stamps on it.
pub fn retry_key_of(channel: &str, payload: &Map<String, Value>) -> String {
    let mut fields: Vec<(&String, &Value)> = payload
        .iter()
        .filter(|(key, _)| key.as_str() != TRACE_FIELD && key.as_str() != "_userId")
        .collect();
    fields.sort_by(|a, b| a.0.cmp(b.0));
    let fields: Vec<Value> = fields
        .into_iter()
        .map(|(key, value)| Value::Array(vec![Value::String(key.clone()), value.clone()]))
        .collect();
    format!("{channel} {}", Value::Array(fields))
}

/// What the gateway answers a request with: its `response`, or `None` for a
/// reply that carries none; refused with a message when nothing answers it.
pub type MakeResponse =
    dyn Fn(&str, &Map<String, Value>) -> Result<Option<Value>, String> + Send + Sync;

/// The failure the gateway answers a request with, when it answers it with
/// one: the payload of the operation's failure channel.
pub type Refuse = dyn Fn(&str, &Map<String, Value>) -> Option<Value> + Send + Sync;

struct Inner {
    /// The global channels the stream names.
    channels: Vec<String>,
    schedule: Vec<FaultAction>,
    make_response: Box<MakeResponse>,
    refuse: Mutex<Option<Box<Refuse>>>,
    replies: Mutex<HashMap<String, VecDeque<Option<Value>>>>,
    log: Mutex<Vec<RequestLogEntry>>,
    emitted: Mutex<Vec<Frame>>,
    /// How many holds each resource's scope has.
    held: Mutex<HashMap<ResourceId, usize>>,
    requests: AtomicUsize,
    hub: FrameHub,
    router: Arc<ReplyRouter>,
    state: watch::Sender<ConnectionState>,
    /// `None` once closed.
    failures: Mutex<Option<FailureStream>>,
    bridges: Mutex<Vec<Arc<EventBus>>>,
    closed: AtomicBool,
}

impl Inner {
    /// Whether the stream carries a frame of `channel` on `scope`: one of the
    /// global channels it names, or a resource's channel on a scope it holds.
    fn carries(&self, channel: &str, scope: Option<&ResourceId>) -> bool {
        self.channels.iter().any(|named| named == channel)
            || (RESOURCE_SCOPED_CHANNELS.contains(&channel)
                && scope.is_some_and(|scope| locked(&self.held).contains_key(scope)))
    }

    /// A frame, or the refusal a transport delivers in its place, when the
    /// stream carries it: to the request that awaits it, to the client's own
    /// bus, and to its channel's readers, as a wire transport does.
    fn deliver(&self, carried: Result<Frame, FrameRefusal>) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let (channel, scope) = match &carried {
            Ok(frame) => (frame.channel.as_str(), frame.scope.as_ref()),
            Err(refusal) => (refusal.channel.as_str(), refusal.scope.as_ref()),
        };
        if !self.carries(channel, scope) {
            return;
        }
        self.router.route(carried.as_ref());
        self.bridge(&carried);
        self.hub.deliver(carried);
    }

    /// Publish into each bus the transport is bridged into, globally: a
    /// frame keeps where on the stream it was delivered.
    fn bridge(&self, carried: &Result<Frame, FrameRefusal>) {
        for bus in locked(&self.bridges).iter() {
            match carried {
                Ok(frame) => {
                    bus.emit_frame(Frame {
                        scope: None,
                        trace: None,
                        ..frame.clone()
                    });
                }
                Err(refusal) => {
                    bus.emit_refusal(FrameRefusal {
                        scope: None,
                        ..refusal.clone()
                    });
                }
            }
        }
    }
}

/// See the module's documentation.
#[derive(Clone)]
pub struct FaultyTransport {
    inner: Arc<Inner>,
}

impl FaultyTransport {
    /// A transport whose stream names `channels` and whose i-th request
    /// meets `schedule[i % len]`; with an empty schedule every reply is
    /// delivered. Nothing is scripted to answer: `queue_reply` says what the
    /// gateway answers.
    pub fn new(channels: &[&str], schedule: Vec<FaultAction>) -> FaultyTransport {
        FaultyTransport::answering(channels, schedule, |operation, _| {
            Err(format!(
                "No response scripted for bus operation \"{operation}\". Script one with queue_reply(\"{operation}\", ...) or build the transport with FaultyTransport::answering."
            ))
        })
    }

    /// The same, with `make_response` answering every request no queued
    /// response does.
    pub fn answering(
        channels: &[&str],
        schedule: Vec<FaultAction>,
        make_response: impl Fn(&str, &Map<String, Value>) -> Result<Option<Value>, String>
        + Send
        + Sync
        + 'static,
    ) -> FaultyTransport {
        FaultyTransport {
            inner: Arc::new(Inner {
                channels: channels.iter().map(ToString::to_string).collect(),
                schedule,
                make_response: Box::new(make_response),
                refuse: Mutex::new(None),
                replies: Mutex::new(HashMap::new()),
                log: Mutex::new(Vec::new()),
                emitted: Mutex::new(Vec::new()),
                held: Mutex::new(HashMap::new()),
                requests: AtomicUsize::new(0),
                hub: FrameHub::new(),
                router: ReplyRouter::new(),
                state: watch::channel(ConnectionState::Open).0,
                failures: Mutex::new(Some(FailureStream::new())),
                bridges: Mutex::new(Vec::new()),
                closed: AtomicBool::new(false),
            }),
        }
    }

    /// Queue what the gateway answers the next requests of `operation` with,
    /// one each, before `make_response` is asked: a `response`, or `None` for
    /// a reply that carries none. A reply that names what it answers for
    /// beside its response (the resource a context was gathered for, the
    /// reference a search was for) names what its request did, as a gateway's
    /// does: a test queues the response alone.
    pub fn queue_reply(&self, operation: &str, responses: impl IntoIterator<Item = Option<Value>>) {
        locked(&self.inner.replies)
            .entry(operation.to_owned())
            .or_default()
            .extend(responses);
    }

    /// Have the gateway answer with a failure every request `refuse` gives
    /// one for: the payload of the operation's failure channel, such as
    /// `{"code": "not-found", "message": "…"}`. Asked before anything queued
    /// or scripted to answer.
    pub fn refuse_when(
        &self,
        refuse: impl Fn(&str, &Map<String, Value>) -> Option<Value> + Send + Sync + 'static,
    ) {
        *locked(&self.inner.refuse) = Some(Box::new(refuse));
    }

    /// Report a failure on the failure stream, as a transport does of a
    /// request the gateway refused. One reported before anyone listens is
    /// kept for the first listener, as a wire transport keeps it.
    pub fn fail(&self, error: TransportError) {
        if let Some(failures) = locked(&self.inner.failures).as_ref() {
            failures.report(&error);
        }
    }

    /// Every request sent, in order.
    pub fn request_log(&self) -> Vec<RequestLogEntry> {
        locked(&self.inner.log).clone()
    }

    /// Every frame emitted through it, in order: the requests, and what was
    /// only sent.
    pub fn emitted(&self) -> Vec<Frame> {
        locked(&self.inner.emitted).clone()
    }

    /// How many holds there are on a resource's scope.
    pub fn holds(&self, resource_id: &ResourceId) -> usize {
        locked(&self.inner.held)
            .get(resource_id)
            .copied()
            .unwrap_or(0)
    }

    /// The resources whose scope is held, in name order.
    pub fn scopes(&self) -> Vec<ResourceId> {
        let mut scopes: Vec<ResourceId> = locked(&self.inner.held).keys().cloned().collect();
        scopes.sort();
        scopes
    }

    /// The correlation ids of the replies still awaited.
    pub fn pending_replies(&self) -> Vec<String> {
        self.inner.router.awaited()
    }

    /// Change the connection's state, as a wire would.
    pub fn set_state(&self, state: ConnectionState) {
        if !self.inner.closed.load(Ordering::SeqCst) {
            self.inner.state.send_replace(state);
        }
    }

    /// Deliver a frame as if the bus had carried it: one the stream does not
    /// carry is lost, as on a wire.
    pub fn deliver(&self, frame: Frame) {
        self.inner.deliver(Ok(frame));
    }

    /// Deliver a frame as the stream delivers one on its scope, with the
    /// event id `id` the stream gave it: it keeps where on the stream it was
    /// delivered (`Frame::stream_id`), as a wire transport's does. A frame of
    /// no scope is no test of this.
    pub fn deliver_recorded(&self, frame: Frame, id: &str) {
        let Some(scope) = frame.scope.clone() else {
            panic!("FaultyTransport: a recorded frame is delivered on its scope");
        };
        self.inner.deliver(Ok(Frame {
            stream_id: Some(StreamId {
                scope,
                event_id: id.to_owned(),
            }),
            ..frame
        }));
    }

    /// Deliver a refusal as if the bus had carried a frame this transport
    /// refused that names its readers.
    pub fn deliver_refusal(&self, refusal: FrameRefusal) {
        self.inner.deliver(Err(refusal));
    }
}

impl Transport for FaultyTransport {
    fn base_url(&self) -> &str {
        "faulty://simulator"
    }

    fn emit<'a>(
        &'a self,
        channel: &'a str,
        payload: Map<String, Value>,
        envelope: Envelope,
    ) -> BoxFuture<'a, Result<Option<u64>, TransportError>> {
        Box::pin(async move {
            let inner = &self.inner;
            if inner.closed.load(Ordering::SeqCst) {
                return Ok(None);
            }
            let request = Frame {
                channel: channel.to_owned(),
                payload: payload.clone(),
                correlation_id: envelope.correlation_id.clone(),
                scope: envelope.scope.clone(),
                trace: None,
                stream_id: None,
            };
            locked(&inner.emitted).push(request.clone());
            let Some(op) = operation(channel) else {
                inner.deliver(Ok(request));
                return Ok(Some(1));
            };

            let action = if inner.schedule.is_empty() {
                FaultAction::Deliver
            } else {
                inner.schedule[inner.requests.load(Ordering::SeqCst) % inner.schedule.len()]
            };
            inner.requests.fetch_add(1, Ordering::SeqCst);
            locked(&inner.log).push(RequestLogEntry {
                channel: channel.to_owned(),
                action,
                correlation_id: envelope.correlation_id.clone(),
                retry_key: retry_key_of(channel, &payload),
                payload: payload.clone(),
            });
            if action == FaultAction::RejectEmit {
                return Err(TransportError::without_response(
                    format!("FaultyTransport: emit rejected by schedule on {channel}"),
                    TransportErrorCode::Error,
                ));
            }

            // The gateway answers once per request that reaches it, whatever
            // the wire then does to the answer.
            let refused = locked(&inner.refuse)
                .as_ref()
                .and_then(|refuse| refuse(channel, &payload));
            let (reply_channel, reply_payload) = match refused {
                Some(Value::Object(failure)) => (op.failure, failure),
                Some(other) => {
                    return Err(TransportError::without_response(
                        format!("FaultyTransport: a failure is a JSON object, not {other}"),
                        TransportErrorCode::Error,
                    ));
                }
                None => {
                    let queued = locked(&inner.replies)
                        .get_mut(channel)
                        .and_then(VecDeque::pop_front);
                    let response = match queued {
                        Some(response) => response,
                        None => (inner.make_response)(channel, &payload).map_err(|refusal| {
                            TransportError::without_response(refusal, TransportErrorCode::Error)
                        })?,
                    };
                    let mut reply_payload = Map::new();
                    // A reply that names what it answers for names what its
                    // request did, as a gateway's does.
                    for named in reply_names(channel) {
                        let stated = payload.get(*named).ok_or_else(|| {
                            TransportError::without_response(
                                format!(
                                    "FaultyTransport: the reply to {channel} names \"{named}\", which this request does not state"
                                ),
                                TransportErrorCode::Error,
                            )
                        })?;
                        reply_payload.insert((*named).to_owned(), stated.clone());
                    }
                    if let Some(response) = response {
                        reply_payload.insert("response".to_owned(), response);
                    }
                    (op.result, reply_payload)
                }
            };
            inner.deliver(Ok(request));

            let reply = Frame {
                channel: reply_channel.to_owned(),
                payload: reply_payload,
                correlation_id: envelope.correlation_id,
                scope: None,
                trace: None,
                stream_id: None,
            };
            let (copies, after) = match action {
                FaultAction::Deliver => (1, Duration::ZERO),
                FaultAction::DuplicateReply => (2, Duration::ZERO),
                FaultAction::Delay(after) => (1, after),
                FaultAction::DropReply | FaultAction::RejectEmit => (0, Duration::ZERO),
            };
            if copies > 0 {
                let inner = self.inner.clone();
                tokio::spawn(async move {
                    if !after.is_zero() {
                        tokio::time::sleep(after).await;
                    }
                    for _ in 0..copies {
                        inner.deliver(Ok(reply.clone()));
                    }
                });
            }
            Ok(Some(1))
        })
    }

    /// A channel the stream names, or a resource's channel, which it carries
    /// on each scope it holds.
    fn frames(&self, channel: &str) -> Result<Frames, BusRequestError> {
        if !self.is_subscribed(channel) && !RESOURCE_SCOPED_CHANNELS.contains(&channel) {
            return Err(BusRequestError::new(
                BusRequestErrorCode::Unsubscribed,
                format!("FaultyTransport: the stream does not name {channel}"),
            ));
        }
        Ok(self.inner.hub.frames(channel))
    }

    fn is_subscribed(&self, channel: &str) -> bool {
        self.inner.channels.iter().any(|named| named == channel)
    }

    /// The stream carries the resource's channels on its scope from the
    /// first hold until the last lets go.
    fn subscribe_to_resource(&self, resource_id: &ResourceId) -> ResourceHold {
        *locked(&self.inner.held)
            .entry(resource_id.clone())
            .or_insert(0) += 1;
        let inner = self.inner.clone();
        let resource_id = resource_id.clone();
        ResourceHold::new(move || {
            let mut held = locked(&inner.held);
            if let Some(holds) = held.get_mut(&resource_id) {
                *holds -= 1;
                if *holds == 0 {
                    held.remove(&resource_id);
                }
            }
        })
    }

    fn state(&self) -> watch::Receiver<ConnectionState> {
        self.inner.state.subscribe()
    }

    fn failures(&self) -> Failures {
        match locked(&self.inner.failures).as_ref() {
            Some(failures) => failures.listen(),
            None => Events::new(broadcast::channel(1).1),
        }
    }

    fn tell_failures_to(&self, listener: FailureListener) {
        if let Some(failures) = locked(&self.inner.failures).as_mut() {
            failures.tell_to(listener);
        }
    }

    fn track_reply(&self, correlation_id: &str, reply_channels: &[&str]) -> PendingReply {
        self.inner.router.track(correlation_id, reply_channels)
    }

    fn bridge_into(&self, bus: Arc<EventBus>) {
        locked(&self.inner.bridges).push(bus);
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if self.inner.closed.swap(true, Ordering::SeqCst) {
                return;
            }
            self.inner.state.send_replace(ConnectionState::Closed);
            self.inner.hub.close();
            self.inner.router.close();
            *locked(&self.inner.failures) = None;
        })
    }
}
