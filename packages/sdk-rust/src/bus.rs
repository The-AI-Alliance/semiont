//! A client of a knowledge base's bus, over any `Transport`: emit, observe,
//! and request.
//!
//! A request (docs/protocol/TRANSPORT-CONTRACT.md § Requests) is one emit
//! carrying a correlation id of this client's making on its envelope, answered
//! on its operation's result or failure channel (the registry's `operations`).
//! It is not sent before the stream that carries its reply is open; its id is
//! tracked until it settles, so a reply published while the stream was down
//! is sent again; and it settles once, with the response, with a failure
//! under this vocabulary's code, or as a timeout. A caller abandons a request
//! by dropping its future: what was sent stays sent, the reply stops being
//! tracked, and one that comes anyway reaches nobody.
//!
//! Every method comes twice. By type (`emit`, `stream`, `request`), the
//! channel is a type of `crate::channels` and the payload is that channel's
//! own, so a wrong payload for a channel does not compile:
//!
//! ```
//! # use semiont::bus::Bus;
//! # use semiont::channels::BeckonFocus;
//! # use semiont::transport::Envelope;
//! # use semiont::types::BeckonFocusEvent;
//! # async fn focus(bus: &Bus, event: BeckonFocusEvent) {
//! let _ = bus.emit::<BeckonFocus>(&event, Envelope::default()).await;
//! # }
//! ```
//!
//! ```compile_fail
//! # use semiont::bus::Bus;
//! # use semiont::channels::JobCreate;
//! # use semiont::transport::Envelope;
//! # use semiont::types::BeckonFocusEvent;
//! # async fn focus(bus: &Bus, event: BeckonFocusEvent) {
//! let _ = bus.emit::<JobCreate>(&event, Envelope::default()).await;
//! # }
//! ```
//!
//! By name (`emit_on`, `frames_on`, `request_of`), the channel is the
//! registry's name and the payload a JSON object: for what relays frames it
//! does not read, or is told its channels at run time.

use crate::channels::{Channel, Request, Scoped, Unscoped};
use crate::errors::{
    BusRequestError, BusRequestErrorCode, SemiontError, TransportError, TransportErrorCode,
};
use crate::transport::{
    ConnectionState, Envelope, Frame, Frames, Lagged, ResourceHold, TraceCarrier, Transport,
};
use crate::types::ResourceId;
use futures_core::Stream;
use serde::Serialize;
use serde_json::{Map, Value};
use std::fmt;
use std::marker::PhantomData;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::time::Instant;

/// A registry operation: the request, and the channels its reply and failure come on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Operation {
    pub request: &'static str,
    pub result: &'static str,
    pub failure: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/operations.rs"));

/// The operation `request` is the request of, as the registry declares it.
pub fn operation(request: &str) -> Option<&'static Operation> {
    OPERATIONS.iter().find(|op| op.request == request)
}

/// What the reply to `request` states beside its `response`: properties of the
/// request, which a gateway states again in its reply. Nothing, for most.
pub fn reply_names(request: &str) -> &'static [&'static str] {
    REPLY_NAMES
        .iter()
        .find(|(asked, _)| *asked == request)
        .map_or(&[][..], |(_, named)| *named)
}

/// The result and failure channels of every operation among `channels`, each
/// once: what a client that awaits only those operations names as its global
/// channels. A channel that is no operation's request contributes nothing.
pub fn reply_channels_for(channels: &[&str]) -> Vec<&'static str> {
    let mut replies = Vec::new();
    for op in channels.iter().filter_map(|channel| operation(channel)) {
        for reply in [op.result, op.failure] {
            if !replies.contains(&reply) {
                replies.push(reply);
            }
        }
    }
    replies
}

/// A payload as the bus carries it: a JSON object.
pub fn payload_of(payload: &impl Serialize) -> Result<Map<String, Value>, TransportError> {
    match serde_json::to_value(payload) {
        Ok(Value::Object(fields)) => Ok(fields),
        Ok(other) => Err(TransportError::without_response(
            format!("a payload is a JSON object, not {other}"),
            TransportErrorCode::Error,
        )),
        Err(error) => Err(TransportError::without_response(
            format!("a payload that does not serialize: {error}"),
            TransportErrorCode::Error,
        )),
    }
}

#[derive(Clone)]
pub struct Bus {
    transport: Arc<dyn Transport>,
}

impl Bus {
    pub fn new(transport: Arc<dyn Transport>) -> Bus {
        Bus { transport }
    }

    pub fn transport(&self) -> &Arc<dyn Transport> {
        &self.transport
    }

    /// Send one frame on the channel named `channel`.
    pub async fn emit_on(
        &self,
        channel: &str,
        payload: Map<String, Value>,
        envelope: Envelope,
    ) -> Result<Option<u64>, TransportError> {
        self.transport.emit(channel, payload, envelope).await
    }

    /// The frames delivered on the channel named `channel` from now on.
    pub fn frames_on(&self, channel: &str) -> Result<Frames, BusRequestError> {
        self.transport.frames(channel)
    }

    /// Send `payload` as the request of `operation` and wait up to `within`
    /// for its reply: the reply's `response`, or `None` when it carries none.
    pub async fn request_of(
        &self,
        operation: &Operation,
        payload: Map<String, Value>,
        within: Duration,
    ) -> Result<Option<Value>, SemiontError> {
        let mut result = self.result_of(operation, payload, within).await?;
        Ok(result.payload.remove("response"))
    }

    /// A request, as far as its result: the frame that answers it on its
    /// operation's result channel. A failure is the request's error.
    async fn result_of(
        &self,
        operation: &Operation,
        payload: Map<String, Value>,
        within: Duration,
    ) -> Result<Frame, SemiontError> {
        let deadline = Instant::now() + within;
        for channel in [operation.result, operation.failure] {
            if !self.transport.is_subscribed(channel) {
                return Err(BusRequestError::new(
                    BusRequestErrorCode::Unsubscribed,
                    format!(
                        "Transport is not subscribed to reply channel {channel}: a reply to {} can never arrive. Add this operation's reply channels to the transport's channels.",
                        operation.request
                    ),
                )
                .into());
            }
        }
        let timed_out = || {
            BusRequestError::new(
                BusRequestErrorCode::Timeout,
                format!(
                    "Bus request timed out after {}ms on {}",
                    within.as_millis(),
                    operation.result
                ),
            )
        };

        // No request before its reply can arrive: wait, inside the request's
        // own deadline, for the stream to be open. Only `Open` delivers; a
        // closed bus fails at once rather than burning the deadline.
        let closed_before_emit = || {
            BusRequestError::new(
                BusRequestErrorCode::Closed,
                format!("Bus closed before emit on {}", operation.request),
            )
        };
        let mut state = self.transport.state();
        loop {
            match *state.borrow_and_update() {
                ConnectionState::Open => break,
                ConnectionState::Closed => return Err(closed_before_emit().into()),
                _ => {}
            }
            tokio::select! {
                changed = state.changed() => {
                    if changed.is_err() {
                        return Err(closed_before_emit().into());
                    }
                }
                () = tokio::time::sleep_until(deadline) => return Err(timed_out().into()),
            }
        }

        // Tracked before the emit, so a stream opened while the emit is in
        // flight already names the reply.
        let correlation_id = uuid::Uuid::new_v4().to_string();
        let mut pending = self
            .transport
            .track_reply(&correlation_id, &[operation.result, operation.failure]);
        let envelope = Envelope {
            correlation_id: Some(correlation_id),
            scope: None,
        };
        self.transport
            .emit(operation.request, payload, envelope)
            .await?;

        let reply = tokio::select! {
            biased;
            reply = pending.frame() => reply,
            () = tokio::time::sleep_until(deadline) => return Err(timed_out().into()),
        };
        let Some(reply) = reply else {
            return Err(BusRequestError::new(
                BusRequestErrorCode::Closed,
                format!("Bus closed before a reply on {}", operation.result),
            )
            .into());
        };
        if reply.channel == operation.result {
            return Ok(reply);
        }
        let message = reply
            .payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Bus request rejected")
            .to_owned();
        Err(BusRequestError {
            code: BusRequestErrorCode::of_wire(reply.payload.get("code").and_then(Value::as_str)),
            message,
            failure: Some(reply.payload),
        }
        .into())
    }
}

// ── By type ─────────────────────────────────────────────────────────────

/// A frame of the channel `C`, its payload decoded.
pub struct Delivered<C: Channel> {
    pub payload: C::Payload,
    pub correlation_id: Option<String>,
    pub scope: Option<ResourceId>,
    /// The DID of whoever emitted it, as the gateway stamped it.
    pub user_id: Option<String>,
    pub trace: Option<TraceCarrier>,
}

/// Why a typed stream could not give its next frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamError {
    /// The reader fell behind and missed this many frames.
    Lagged(u64),
    /// A frame arrived whose payload is not the channel's.
    Undecodable(String),
}

impl fmt::Display for StreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StreamError::Lagged(missed) => Lagged(*missed).fmt(f),
            StreamError::Undecodable(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for StreamError {}

/// A payload as the channel `C` types it. A gateway's stamps the type does
/// not declare are the bus's, not the payload's, and are left out.
pub(crate) fn decoded<C: Channel>(mut payload: Map<String, Value>) -> Result<C::Payload, String> {
    payload.retain(|key, _| !key.starts_with('_') || C::STAMPS.contains(&key.as_str()));
    serde_json::from_value(Value::Object(payload))
        .map_err(|error| format!("a payload on {} is not that channel's: {error}", C::NAME))
}

fn delivered<C: Channel>(frame: Frame) -> Result<Delivered<C>, StreamError> {
    let user_id = frame
        .payload
        .get("_userId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(Delivered {
        payload: decoded::<C>(frame.payload).map_err(StreamError::Undecodable)?,
        correlation_id: frame.correlation_id,
        scope: frame.scope,
        user_id,
        trace: frame.trace,
    })
}

/// The frames of the channel `C`, each with its payload decoded, out of the
/// frames `F` gives: a transport's (`Frames`), or a client's own bus's
/// (`crate::event_bus::BusFrames`).
pub struct Typed<C: Channel, F = Frames> {
    frames: F,
    channel: PhantomData<fn() -> C>,
}

impl<C: Channel, F> Typed<C, F> {
    pub(crate) fn of(frames: F) -> Typed<C, F> {
        Typed {
            frames,
            channel: PhantomData,
        }
    }
}

impl<C: Channel, F: Stream<Item = Result<Frame, Lagged>> + Unpin> Typed<C, F> {
    /// The next frame; `None` when the stream has ended.
    pub async fn next(&mut self) -> Option<Result<Delivered<C>, StreamError>> {
        std::future::poll_fn(|cx| Pin::new(&mut *self).poll_next(cx)).await
    }
}

impl<C: Channel, F: Stream<Item = Result<Frame, Lagged>> + Unpin> Stream for Typed<C, F> {
    type Item = Result<Delivered<C>, StreamError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.frames).poll_next(cx).map(|item| {
            item.map(|item| match item {
                Ok(frame) => delivered::<C>(frame),
                Err(Lagged(missed)) => Err(StreamError::Lagged(missed)),
            })
        })
    }
}

/// One resource's frames out of a transport's: those of its scope, with the
/// hold on that scope that brings them. Dropped, it lets go of the scope.
pub struct ScopedFrames {
    frames: Frames,
    resource: ResourceId,
    _hold: ResourceHold,
}

impl Stream for ScopedFrames {
    type Item = Result<Frame, Lagged>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            match Pin::new(&mut self.frames).poll_next(cx) {
                // A stream carries every scope it holds on the one channel,
                // and another reader may hold another resource's.
                Poll::Ready(Some(Ok(frame))) if frame.scope.as_ref() != Some(&self.resource) => {}
                other => return other,
            }
        }
    }
}

impl Bus {
    /// Send one frame on the channel `C`.
    pub async fn emit<C: Channel>(
        &self,
        payload: &C::Payload,
        envelope: Envelope,
    ) -> Result<Option<u64>, TransportError> {
        self.emit_on(C::NAME, payload_of(payload)?, envelope).await
    }

    /// The frames delivered on the channel `C` from now on.
    ///
    /// `C` is a channel of no resource's scope. One a resource's scope
    /// carries is read for a resource (`stream_of`), and does not compile
    /// here, where nothing would ever be delivered to it:
    ///
    /// ```compile_fail,E0277
    /// use semiont::bus::Bus;
    /// use semiont::channels::MarkAdded;
    ///
    /// fn read(bus: &Bus) {
    ///     let _ = bus.stream::<MarkAdded>();
    /// }
    /// ```
    pub fn stream<C: Unscoped>(&self) -> Result<Typed<C>, BusRequestError> {
        Ok(Typed::of(self.frames_on(C::NAME)?))
    }

    /// The frames delivered on the channel `C` for `resource` from now on.
    ///
    /// `C` is a channel a resource's scope carries, and reaches only a
    /// client that holds that scope. So the read holds it, from this call
    /// until what it returns is dropped, and is given that resource's frames
    /// and no other's.
    ///
    /// ```
    /// use semiont::bus::Bus;
    /// use semiont::channels::MarkAdded;
    /// use semiont::types::ResourceId;
    ///
    /// async fn follow(bus: &Bus, resource: &ResourceId) {
    ///     let Ok(mut added) = bus.stream_of::<MarkAdded>(resource) else {
    ///         return;
    ///     };
    ///     while let Some(Ok(frame)) = added.next().await {
    ///         println!("{}", frame.payload.id);
    ///     }
    /// }
    /// ```
    pub fn stream_of<C: Scoped>(
        &self,
        resource: &ResourceId,
    ) -> Result<Typed<C, ScopedFrames>, BusRequestError> {
        let frames = self.frames_on(C::NAME)?;
        Ok(Typed::of(ScopedFrames {
            frames,
            resource: resource.clone(),
            _hold: self.transport.subscribe_to_resource(resource),
        }))
    }

    /// Send `payload` as the request of the operation `R` and wait up to
    /// `within` for its result.
    pub async fn request<R: Request>(
        &self,
        payload: &R::Payload,
        within: Duration,
    ) -> Result<<R::Result as Channel>::Payload, SemiontError> {
        let operation = Operation {
            request: R::NAME,
            result: <R::Result as Channel>::NAME,
            failure: <R::Failure as Channel>::NAME,
        };
        let result = self
            .result_of(&operation, payload_of(payload)?, within)
            .await?;
        decoded::<R::Result>(result.payload)
            .map_err(|why| TransportError::without_response(why, TransportErrorCode::Error).into())
    }
}
