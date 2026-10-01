//! A client of a knowledge base's bus, over any `Transport`: emit, reply, and
//! request. A request is an emit with a correlation id, answered on its
//! operation's result or failure channel (the registry's `operations`), and
//! kept deliverable across a reconnect until it is answered or abandoned.

use crate::transport::{Envelope, Received, Transport, TransportError};
use serde::Serialize;
use serde_json::{Map, Value};
use std::fmt;
use std::time::Duration;
use tokio::sync::broadcast;

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

/// Why the bus refused, or failed, something asked of it.
#[derive(Debug)]
pub enum BusError {
    /// The transport could not carry the emit.
    Transport(TransportError),
    /// A payload that does not serialize as a JSON object.
    Payload(String),
    /// `request` named a channel the registry declares no operation for.
    NotAnOperation(String),
    /// The transport does not receive the channel the reply would come on,
    /// so it could never arrive.
    Unsubscribed { operation: String, channel: String },
    /// No reply within the time the request allowed.
    Timeout { operation: String },
    /// The transport stopped before the reply came.
    Closed,
}

impl fmt::Display for BusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BusError::Transport(error) => write!(f, "{error}"),
            BusError::Payload(message) => f.write_str(message),
            BusError::NotAnOperation(channel) => write!(f, "{channel} is not a registry operation"),
            BusError::Unsubscribed { operation, channel } => write!(
                f,
                "a reply to {operation} comes on {channel}, which this client does not subscribe to"
            ),
            BusError::Timeout { operation } => write!(f, "no reply to {operation} in time"),
            BusError::Closed => f.write_str("the bus client stopped"),
        }
    }
}

impl std::error::Error for BusError {}

/// A reply to a request: its result, or its failure (a `CommandError`).
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    Result(Map<String, Value>),
    Failure(Map<String, Value>),
}

pub struct Bus<T: Transport> {
    transport: T,
}

impl<T: Transport> Bus<T> {
    pub fn new(transport: T) -> Bus<T> {
        Bus { transport }
    }

    /// Every frame from now on, of every channel the transport receives.
    pub fn frames(&self) -> broadcast::Receiver<Received> {
        self.transport.frames()
    }

    /// Emit a frame, globally unless `scope` is given, with no reply expected.
    pub async fn emit(
        &self,
        channel: &str,
        payload: &impl Serialize,
        scope: Option<&str>,
    ) -> Result<(), BusError> {
        let envelope = Envelope {
            correlation_id: None,
            scope: scope.map(str::to_owned),
        };
        self.send(channel, object(payload)?, envelope).await
    }

    /// Answer a request: a frame on `channel` carrying the request's correlation id.
    pub async fn reply(
        &self,
        channel: &str,
        payload: &impl Serialize,
        correlation_id: &str,
    ) -> Result<(), BusError> {
        let envelope = Envelope {
            correlation_id: Some(correlation_id.to_owned()),
            scope: None,
        };
        self.send(channel, object(payload)?, envelope).await
    }

    /// Send `payload` as the request of `operation` and wait up to `within`
    /// for its result or its failure.
    pub async fn request(
        &self,
        operation: &str,
        payload: &impl Serialize,
        within: Duration,
    ) -> Result<Reply, BusError> {
        let op = self::operation(operation)
            .ok_or_else(|| BusError::NotAnOperation(operation.to_owned()))?;
        for channel in [op.result, op.failure] {
            if !self.transport.is_subscribed(channel) {
                return Err(BusError::Unsubscribed {
                    operation: operation.to_owned(),
                    channel: channel.to_owned(),
                });
            }
        }
        let payload = object(payload)?;
        let correlation_id = uuid::Uuid::new_v4().to_string();
        let mut frames = self.transport.frames();
        self.transport.track_reply(&correlation_id);
        let envelope = Envelope {
            correlation_id: Some(correlation_id.clone()),
            scope: None,
        };
        let answer = match self.send(operation, payload, envelope).await {
            Err(error) => Err(error),
            Ok(()) => tokio::time::timeout(within, async {
                loop {
                    match frames.recv().await {
                        Ok(Received { frame, .. })
                            if frame.correlation_id.as_deref() == Some(correlation_id.as_str()) =>
                        {
                            if frame.channel == op.result {
                                return Ok(Reply::Result(frame.payload));
                            }
                            if frame.channel == op.failure {
                                return Ok(Reply::Failure(frame.payload));
                            }
                        }
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => return Err(BusError::Closed),
                    }
                }
            })
            .await
            .unwrap_or_else(|_| {
                Err(BusError::Timeout {
                    operation: operation.to_owned(),
                })
            }),
        };
        self.transport.release_reply(&correlation_id);
        answer
    }

    async fn send(
        &self,
        channel: &str,
        payload: Map<String, Value>,
        envelope: Envelope,
    ) -> Result<(), BusError> {
        self.transport
            .emit(channel, payload, envelope)
            .await
            .map(|_| ())
            .map_err(BusError::Transport)
    }
}

fn object(payload: &impl Serialize) -> Result<Map<String, Value>, BusError> {
    match serde_json::to_value(payload) {
        Ok(Value::Object(fields)) => Ok(fields),
        Ok(other) => Err(BusError::Payload(format!(
            "a payload is a JSON object, not {other}"
        ))),
        Err(e) => Err(BusError::Payload(e.to_string())),
    }
}
