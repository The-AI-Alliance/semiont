//! A client of a knowledge base's bus, over its gateway's HTTP transport
//! (docs/protocol/TRANSPORT-HTTP.md): one stream, `POST /bus/subscribe`, for
//! the channels it names, and `POST /bus/emit` for what it sends. A request is
//! an emit with a correlation id, answered on its operation's result or
//! failure channel (the registry's `operations`); the gateway routes that
//! answer to this client alone.
//!
//! The stream is held open for as long as the client lives: when it ends or
//! is refused, it is opened again after a pause that doubles up to a minute,
//! naming the requests still waiting (`pendingReplies`) so an answer sent
//! while it was down still arrives. A 401 is answered by exchanging the
//! session's token once.

use crate::session::{AgentSession, SessionError};
use crate::types::{BusEmitRequest, BusFrame, BusSubscribeRequest};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fmt;
use std::sync::{Arc, Mutex};
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

/// The first pause before the stream is opened again; it doubles to `MAX_PAUSE`.
const FIRST_PAUSE: Duration = Duration::from_millis(500);
const MAX_PAUSE: Duration = Duration::from_secs(60);
/// How many frames a slow reader may fall behind before it misses some.
const BACKLOG: usize = 4096;

/// Why the bus refused, or failed, something asked of it.
#[derive(Debug)]
pub enum BusError {
    /// The session could not give a token.
    Session(SessionError),
    /// The gateway could not be reached.
    Unreachable(String),
    /// The gateway refused the emit: its status and body.
    Refused { status: u16, body: String },
    /// A payload that does not serialize as a JSON object.
    Payload(String),
    /// `request` named a channel the registry declares no operation for.
    NotAnOperation(String),
    /// The client is not subscribed to the channel the reply would come on,
    /// so it could never arrive.
    Unsubscribed { operation: String, channel: String },
    /// No reply within the time the request allowed.
    Timeout { operation: String },
    /// The client stopped before the reply came.
    Closed,
}

impl fmt::Display for BusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BusError::Session(error) => write!(f, "{error}"),
            BusError::Unreachable(message) | BusError::Payload(message) => f.write_str(message),
            BusError::Refused { status, body } => {
                write!(f, "the gateway refused ({status}): {body}")
            }
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

pub struct Bus {
    session: Arc<AgentSession>,
    http: reqwest::Client,
    client_id: String,
    channels: Vec<String>,
    frames: broadcast::Sender<BusFrame>,
    /// The correlation ids of requests not yet answered.
    pending: Arc<Mutex<HashSet<String>>>,
    stream: tokio::task::JoinHandle<()>,
}

impl Drop for Bus {
    fn drop(&mut self) {
        self.stream.abort();
    }
}

impl Bus {
    /// A client subscribed to `channels`, for as long as it lives. Frames
    /// arrive on `frames()`; the stream opens in the background.
    pub fn open(session: Arc<AgentSession>, http: reqwest::Client, channels: Vec<String>) -> Bus {
        let client_id = uuid::Uuid::new_v4().to_string();
        let (frames, _) = broadcast::channel(BACKLOG);
        let pending = Arc::new(Mutex::new(HashSet::new()));
        let stream = tokio::spawn(hold_stream(
            session.clone(),
            http.clone(),
            client_id.clone(),
            channels.clone(),
            frames.clone(),
            pending.clone(),
        ));
        Bus {
            session,
            http,
            client_id,
            channels,
            frames,
            pending,
            stream,
        }
    }

    /// Every frame from now on, of every channel the client subscribed to.
    pub fn frames(&self) -> broadcast::Receiver<BusFrame> {
        self.frames.subscribe()
    }

    /// Emit a frame, globally unless `scope` is given, with no reply expected.
    pub async fn emit(
        &self,
        channel: &str,
        payload: &impl Serialize,
        scope: Option<&str>,
    ) -> Result<(), BusError> {
        self.send(BusEmitRequest {
            channel: channel.to_owned(),
            payload: object(payload)?,
            scope: scope.map(str::to_owned),
            client_id: None,
            correlation_id: None,
        })
        .await
    }

    /// Answer a request: a frame on `channel` carrying the request's correlation id.
    pub async fn reply(
        &self,
        channel: &str,
        payload: &impl Serialize,
        correlation_id: &str,
    ) -> Result<(), BusError> {
        self.send(BusEmitRequest {
            channel: channel.to_owned(),
            payload: object(payload)?,
            scope: None,
            client_id: None,
            correlation_id: Some(correlation_id.to_owned()),
        })
        .await
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
            if !self.channels.iter().any(|c| c == channel) {
                return Err(BusError::Unsubscribed {
                    operation: operation.to_owned(),
                    channel: channel.to_owned(),
                });
            }
        }
        let correlation_id = uuid::Uuid::new_v4().to_string();
        let mut frames = self.frames.subscribe();
        self.pending_mut().insert(correlation_id.clone());
        let sent = self
            .send(BusEmitRequest {
                channel: operation.to_owned(),
                payload: object(payload)?,
                scope: None,
                client_id: Some(self.client_id.clone()),
                correlation_id: Some(correlation_id.clone()),
            })
            .await;
        let answer = match sent {
            Err(error) => Err(error),
            Ok(()) => tokio::time::timeout(within, async {
                loop {
                    match frames.recv().await {
                        Ok(frame)
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
        self.pending_mut().remove(&correlation_id);
        answer
    }

    fn pending_mut(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }

    async fn send(&self, body: BusEmitRequest) -> Result<(), BusError> {
        let url = format!("{}/bus/emit", self.session.gateway());
        let mut refreshed = false;
        loop {
            let token = self.session.token().await.map_err(BusError::Session)?;
            let response = self
                .http
                .post(&url)
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
                .map_err(|e| BusError::Unreachable(format!("{url}: {e}")))?;
            let status = response.status().as_u16();
            if status == 401 && !refreshed {
                refreshed = true;
                self.session.refresh().await.map_err(BusError::Session)?;
                continue;
            }
            if response.status().is_success() {
                return Ok(());
            }
            let body = response.text().await.unwrap_or_default();
            return Err(BusError::Refused { status, body });
        }
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

/// Hold the stream open, opening it again whenever it ends.
async fn hold_stream(
    session: Arc<AgentSession>,
    http: reqwest::Client,
    client_id: String,
    channels: Vec<String>,
    frames: broadcast::Sender<BusFrame>,
    pending: Arc<Mutex<HashSet<String>>>,
) {
    let url = format!("{}/bus/subscribe", session.gateway());
    let mut pause = FIRST_PAUSE;
    let mut refreshed = false;
    loop {
        let pending_replies: Vec<String> = pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .cloned()
            .collect();
        let body = BusSubscribeRequest {
            client_id: client_id.clone(),
            global: Some(channels.clone()),
            pending_replies: (!pending_replies.is_empty()).then_some(pending_replies),
            scoped: None,
        };
        let opened = match session.token().await {
            Ok(token) => http
                .post(&url)
                .bearer_auth(&token)
                .header("accept", "text/event-stream")
                .json(&body)
                .send()
                .await
                .ok(),
            Err(_) => None,
        };
        match opened {
            Some(response) if response.status().is_success() => {
                pause = FIRST_PAUSE;
                refreshed = false;
                read_events(response.bytes_stream(), &frames).await;
            }
            Some(response) if response.status().as_u16() == 401 && !refreshed => {
                refreshed = true;
                let _ = session.refresh().await;
                continue;
            }
            _ => {}
        }
        tokio::time::sleep(pause).await;
        pause = (pause * 2).min(MAX_PAUSE);
    }
}

/// Every `bus-event` of a Server-Sent Events stream, as a frame, until it ends.
async fn read_events(
    body: impl Stream<Item = reqwest::Result<Bytes>>,
    frames: &broadcast::Sender<BusFrame>,
) {
    let mut body = std::pin::pin!(body);
    // Bytes until a whole line is in: a chunk may end inside a character.
    let mut buffer: Vec<u8> = Vec::new();
    let mut event = String::new();
    let mut data = String::new();
    while let Some(Ok(chunk)) = body.next().await {
        buffer.extend_from_slice(&chunk);
        while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line[..end])
                .trim_end_matches('\r')
                .to_owned();
            if line.is_empty() {
                if event == "bus-event"
                    && let Ok(frame) = serde_json::from_str::<BusFrame>(&data)
                {
                    let _ = frames.send(frame);
                }
                event.clear();
                data.clear();
                continue;
            }
            let (field, value) = line.split_once(':').unwrap_or((line.as_str(), ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "event" => event = value.to_owned(),
                "data" => {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(value);
                }
                _ => {}
            }
        }
    }
}
