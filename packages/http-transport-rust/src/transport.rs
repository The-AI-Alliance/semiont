//! A knowledge base's bus over its gateway's HTTP transport
//! (docs/protocol/TRANSPORT-HTTP.md): one stream, `POST /bus/subscribe`, for
//! the channels it names, and `POST /bus/emit` for what it sends.
//!
//! The stream is held open for as long as the transport lives: when it ends or
//! is refused, it is opened again after a pause that doubles up to a minute,
//! naming the replies still awaited (`pendingReplies`) so an answer sent while
//! it was down still arrives. A 401 is answered by exchanging the session's
//! token once.
//!
//! What crosses the wire is observed here, as every Semiont transport observes
//! it: each emit is logged (`[bus EMIT]`), counted (`semiont.bus.emit`) and sent
//! in a `bus.emit` span whose trace context travels as `traceparent`; each frame
//! received is logged (`[bus RECV]`), its `_trace` field lifted off the payload
//! for the consumer to continue (`semiont_observability::telemetry::received`).

use crate::session::{AgentSession, SessionError};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use opentelemetry::KeyValue;
use opentelemetry::trace::SpanKind;
use semiont::bus_log::bus_log;
use semiont::transport::{Envelope, Received, TraceCarrier, Transport, TransportError};
use semiont::types::{BusEmitAccepted, BusEmitRequest, BusFrame, BusSubscribeRequest};
use semiont_observability::telemetry;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

/// The first pause before the stream is opened again; it doubles to `MAX_PAUSE`.
const FIRST_PAUSE: Duration = Duration::from_millis(500);
const MAX_PAUSE: Duration = Duration::from_secs(60);
/// How many frames a slow reader may fall behind before it misses some.
const BACKLOG: usize = 4096;
/// Where a frame's payload carries the trace it was sent under.
const TRACE_FIELD: &str = "_trace";

pub struct HttpTransport {
    session: Arc<AgentSession>,
    http: reqwest::Client,
    client_id: String,
    channels: Vec<String>,
    frames: broadcast::Sender<Received>,
    /// The correlation ids of replies still awaited.
    pending: Arc<Mutex<HashSet<String>>>,
    stream: tokio::task::JoinHandle<()>,
}

impl Drop for HttpTransport {
    fn drop(&mut self) {
        self.stream.abort();
    }
}

impl HttpTransport {
    /// A transport subscribed to `channels`, for as long as it lives. The
    /// stream opens in the background.
    pub fn open(
        session: Arc<AgentSession>,
        http: reqwest::Client,
        channels: Vec<String>,
    ) -> HttpTransport {
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
        HttpTransport {
            session,
            http,
            client_id,
            channels,
            frames,
            pending,
            stream,
        }
    }

    fn pending_mut(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }

    async fn post(&self, body: &BusEmitRequest) -> Result<Option<u64>, TransportError> {
        let url = format!("{}/bus/emit", self.session.gateway());
        let mut refreshed = false;
        loop {
            let token = self.session.token().await.map_err(session_error)?;
            let mut request = self.http.post(&url).bearer_auth(&token).json(body);
            if let Some((traceparent, tracestate)) = telemetry::active_trace() {
                request = request.header("traceparent", traceparent);
                if let Some(tracestate) = tracestate {
                    request = request.header("tracestate", tracestate);
                }
            }
            let response = request
                .send()
                .await
                .map_err(|e| TransportError(format!("{url}: {e}")))?;
            let status = response.status().as_u16();
            if status == 401 && !refreshed {
                refreshed = true;
                self.session.refresh().await.map_err(session_error)?;
                continue;
            }
            if response.status().is_success() {
                let accepted = response.json::<BusEmitAccepted>().await.ok();
                return Ok(accepted.and_then(|a| a.subscribers));
            }
            let body = response.text().await.unwrap_or_default();
            return Err(TransportError(format!(
                "the gateway refused ({status}): {body}"
            )));
        }
    }
}

fn session_error(error: SessionError) -> TransportError {
    TransportError(error.to_string())
}

impl Transport for HttpTransport {
    async fn emit(
        &self,
        channel: &str,
        payload: Map<String, Value>,
        envelope: Envelope,
    ) -> Result<Option<u64>, TransportError> {
        bus_log(
            "EMIT",
            channel,
            &Value::Object(payload.clone()),
            envelope.scope.as_deref(),
            envelope.correlation_id.as_deref(),
        );
        telemetry::record_bus_emit(channel, envelope.scope.as_deref());
        let mut attributes = vec![KeyValue::new("bus.channel", channel.to_owned())];
        if let Some(scope) = &envelope.scope {
            attributes.push(KeyValue::new("bus.scope", scope.clone()));
        }
        let body = BusEmitRequest {
            channel: channel.to_owned(),
            payload,
            scope: envelope.scope,
            client_id: Some(self.client_id.clone()),
            correlation_id: envelope.correlation_id,
        };
        telemetry::in_span(
            format!("bus.emit:{channel}"),
            SpanKind::Producer,
            attributes,
            opentelemetry::Context::current(),
            self.post(&body),
        )
        .await
    }

    fn frames(&self) -> broadcast::Receiver<Received> {
        self.frames.subscribe()
    }

    fn is_subscribed(&self, channel: &str) -> bool {
        self.channels.iter().any(|c| c == channel)
    }

    fn track_reply(&self, correlation_id: &str) {
        self.pending_mut().insert(correlation_id.to_owned());
    }

    fn release_reply(&self, correlation_id: &str) {
        self.pending_mut().remove(correlation_id);
    }
}

/// Hold the stream open, opening it again whenever it ends.
async fn hold_stream(
    session: Arc<AgentSession>,
    http: reqwest::Client,
    client_id: String,
    channels: Vec<String>,
    frames: broadcast::Sender<Received>,
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

/// A frame as it arrives: logged, and its trace lifted off its payload.
fn received(mut frame: BusFrame) -> Received {
    let trace = frame.payload.remove(TRACE_FIELD).and_then(|carrier| {
        let traceparent = carrier.get("traceparent")?.as_str()?.to_owned();
        let tracestate = carrier
            .get("tracestate")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Some(TraceCarrier {
            traceparent,
            tracestate,
        })
    });
    bus_log(
        "RECV",
        &frame.channel,
        &Value::Object(frame.payload.clone()),
        frame.scope.as_deref(),
        frame.correlation_id.as_deref(),
    );
    Received { frame, trace }
}

/// Every `bus-event` of a Server-Sent Events stream, as a frame, until it ends.
async fn read_events(
    body: impl Stream<Item = reqwest::Result<Bytes>>,
    frames: &broadcast::Sender<Received>,
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
                    let _ = frames.send(received(frame));
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
