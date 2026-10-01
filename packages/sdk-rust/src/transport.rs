//! What a client needs of the wire beneath it, whatever carries it: publish a
//! payload with its envelope, receive frames, say which channels it receives,
//! and keep an awaited reply deliverable across a reconnect. The bus client
//! (`crate::bus`) is written against this alone; an HTTP gateway's transport
//! is one implementation of it.

use crate::types::BusFrame;
use std::fmt;
use std::future::Future;
use tokio::sync::broadcast;

/// The routing facts beside a payload, never inside it: the correlation id
/// that pairs a reply with its request, and the resource scope of a
/// resource-bound broadcast.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Envelope {
    pub correlation_id: Option<String>,
    pub scope: Option<String>,
}

/// The W3C trace context a frame was sent under, lifted off its payload's
/// `_trace` field, where the gateway carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceCarrier {
    pub traceparent: String,
    pub tracestate: Option<String>,
}

/// A frame as it arrives: the frame, its payload without the trace field, and
/// the trace it was sent under, when it carried one.
#[derive(Debug, Clone, PartialEq)]
pub struct Received {
    pub frame: BusFrame,
    pub trace: Option<TraceCarrier>,
}

/// The transport could not carry an emit: its own account of why.
#[derive(Debug)]
pub struct TransportError(pub String);

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TransportError {}

pub trait Transport: Send + Sync + 'static {
    /// Publish `payload` on `channel`. How many subscribers it reached, when
    /// the transport can count; a broker's plane cannot, and says nothing.
    fn emit(
        &self,
        channel: &str,
        payload: serde_json::Map<String, serde_json::Value>,
        envelope: Envelope,
    ) -> impl Future<Output = Result<Option<u64>, TransportError>> + Send;

    /// Every frame the transport receives, from now on.
    fn frames(&self) -> broadcast::Receiver<Received>;

    /// Whether the transport receives `channel`.
    fn is_subscribed(&self, channel: &str) -> bool;

    /// Keep a reply to `correlation_id` deliverable across a reconnect, until
    /// `release_reply`.
    fn track_reply(&self, correlation_id: &str);

    fn release_reply(&self, correlation_id: &str);
}
