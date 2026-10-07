//! The transport contract (docs/protocol/TRANSPORT-CONTRACT.md): what a
//! client needs of whatever carries the bus, the bytes and the gateway's own
//! answers. Three traits, each usable as a trait object, so a client holds
//! them without naming what carries them:
//!
//! - `Transport`: the bus. An emit out, frames in, the connection's state,
//!   the failures it met, the resource scopes it holds and the replies it
//!   awaits.
//! - `ContentTransport`: bytes, which never ride the bus, and a resource's
//!   description.
//! - `GatewayOperations`: what a gateway answers for itself. A transport with
//!   no gateway behind it does not implement it.
//!
//! Two kinds of thing are observed here, and they behave differently for a
//! reader that falls behind. An **event stream** (`Frames`, `Failures`) is a
//! sequence: a reader is given every item, and one that fell too far behind
//! is told how many it missed (`Lagged`), never left with a silent gap. A
//! **state** (`state()`) is what is true now: a reader always holds the
//! current value, and may see a run of changes as the latest one.

use crate::errors::{BusRequestError, BusRequestErrorCode, TransportError};
use crate::event_bus::EventBus;
use crate::locked;
use crate::types::ResourceId;
use crate::types::{AnnotationId, JobId};
use crate::types::{
    CreateResourceResponse, GetResourceResponse, HealthResponse, MediaTokenResponse,
    ProtectedResourceMetadata, StatusResponse, UserResponse,
};
use bytes::Bytes;
use futures_core::Stream;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fmt;
use std::future::{Future, IntoFuture};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;

/// A future a trait object can return.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How many items of one event stream a reader may fall behind before it
/// misses some.
pub const STREAM_BACKLOG: usize = 1024;

// ── The connection ──────────────────────────────────────────────────────

/// Whether the bus can deliver, as a transport reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConnectionState {
    /// Before the transport has started its stream.
    Initial,
    /// A connect is in flight and no stream is live.
    Connecting,
    /// A stream is live. Left only when the stream drops: a transport that
    /// changes what its stream carries without missing anything stays open,
    /// so `Open` reached again always means something may have been missed.
    Open,
    /// The stream dropped, or a connect failed with none live; retrying.
    Reconnecting,
    /// Has been reconnecting for longer than `DEGRADED_THRESHOLD`.
    Degraded,
    /// Not attempting: there is no credential, or the one there is was
    /// refused. Ends when a different credential appears.
    Unauthenticated,
    /// The transport was closed. Terminal.
    Closed,
}

impl ConnectionState {
    pub const fn as_str(self) -> &'static str {
        match self {
            ConnectionState::Initial => "initial",
            ConnectionState::Connecting => "connecting",
            ConnectionState::Open => "open",
            ConnectionState::Reconnecting => "reconnecting",
            ConnectionState::Degraded => "degraded",
            ConnectionState::Unauthenticated => "unauthenticated",
            ConnectionState::Closed => "closed",
        }
    }
}

// ── Frames ──────────────────────────────────────────────────────────────

/// The routing facts beside a payload, never inside it: the correlation id
/// that pairs a reply with its request, and the resource scope of a
/// resource-bound broadcast.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Envelope {
    pub correlation_id: Option<String>,
    pub scope: Option<ResourceId>,
}

/// The W3C trace context a frame was sent under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceCarrier {
    pub traceparent: String,
    pub tracestate: Option<String>,
}

/// A frame as a transport delivers it: its envelope, its payload, and the
/// trace it was sent under, when it carried one. The payload carries no
/// routing and no trace.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub channel: String,
    pub payload: Map<String, Value>,
    pub correlation_id: Option<String>,
    pub scope: Option<ResourceId>,
    pub trace: Option<TraceCarrier>,
}

/// A reader of an event stream fell behind and missed this many items. On a
/// channel that carries events of the record this is a gap: an unknown set
/// of events was missed, and what was built from them is read again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lagged(pub u64);

impl fmt::Display for Lagged {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "a reader fell behind and missed {} items", self.0)
    }
}

impl std::error::Error for Lagged {}

/// An event stream over a broadcast: every item sent after it was taken, in
/// order, a `Lagged` in place of the ones a slow reader missed, and its end
/// when the sender is gone.
pub struct Events<T> {
    inner: BroadcastStream<T>,
}

impl<T: Clone + Send + 'static> Events<T> {
    pub fn new(receiver: broadcast::Receiver<T>) -> Events<T> {
        Events {
            inner: BroadcastStream::new(receiver),
        }
    }

    /// The next item; `None` when the stream has ended.
    pub async fn next(&mut self) -> Option<Result<T, Lagged>> {
        std::future::poll_fn(|cx| Pin::new(&mut *self).poll_next(cx)).await
    }
}

impl<T: Clone + Send + 'static> Stream for Events<T> {
    type Item = Result<T, Lagged>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.inner).poll_next(cx).map(|item| {
            item.map(|received| {
                received.map_err(|BroadcastStreamRecvError::Lagged(missed)| Lagged(missed))
            })
        })
    }
}

/// The frames delivered on one channel.
pub type Frames = Events<Frame>;
/// The failures a transport met: what a server refused, and what the gateway
/// never answered. Each is reported here as it is returned to its caller.
pub type Failures = Events<TransportError>;

/// A handler's subscription (`Transport::on`): it runs until this is dropped.
pub struct Subscription {
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The frames of every channel anybody listens to, a broadcast per channel:
/// a reader of one channel falls behind only on that channel's traffic. What
/// a transport delivers goes through one of these.
pub struct FrameHub {
    /// `None` once closed.
    channels: Mutex<Option<HashMap<String, broadcast::Sender<Frame>>>>,
}

impl Default for FrameHub {
    fn default() -> FrameHub {
        FrameHub {
            channels: Mutex::new(Some(HashMap::new())),
        }
    }
}

impl FrameHub {
    pub fn new() -> FrameHub {
        FrameHub::default()
    }

    /// The frames delivered on `channel` from now on. Of a closed hub, a
    /// stream that has ended.
    pub fn frames(&self, channel: &str) -> Frames {
        match locked(&self.channels).as_mut() {
            Some(channels) => Events::new(
                channels
                    .entry(channel.to_owned())
                    .or_insert_with(|| broadcast::channel(STREAM_BACKLOG).0)
                    .subscribe(),
            ),
            None => Events::new(broadcast::channel(1).1),
        }
    }

    /// Deliver `frame` to its channel's readers; how many there were.
    pub fn deliver(&self, frame: Frame) -> usize {
        let mut channels = locked(&self.channels);
        let Some(channels) = channels.as_mut() else {
            return 0;
        };
        let Some(sender) = channels.get(&frame.channel) else {
            return 0;
        };
        if sender.receiver_count() == 0 {
            channels.remove(&frame.channel);
            return 0;
        }
        sender.send(frame).unwrap_or(0)
    }

    /// End every stream taken from this hub, and every one taken later.
    pub fn close(&self) {
        *locked(&self.channels) = None;
    }
}

// ── Replies ─────────────────────────────────────────────────────────────

struct Awaited {
    channels: Vec<String>,
    reply: oneshot::Sender<Frame>,
}

/// The replies a transport's requests still await. A reply is routed here by
/// its correlation id to the one request that awaits it, on a channel of its
/// own, so no amount of other traffic can cost a request its reply; and the
/// ids here are what a wire transport names when it opens a stream, so a
/// reply published while the stream was down is sent again.
pub struct ReplyRouter {
    /// `None` once closed.
    awaited: Mutex<Option<HashMap<String, Awaited>>>,
}

impl ReplyRouter {
    pub fn new() -> Arc<ReplyRouter> {
        Arc::new(ReplyRouter {
            awaited: Mutex::new(Some(HashMap::new())),
        })
    }

    /// Await the reply to `correlation_id` on one of `reply_channels`, until
    /// the returned `PendingReply` is dropped.
    pub fn track(self: &Arc<Self>, correlation_id: &str, reply_channels: &[&str]) -> PendingReply {
        let (reply, receiver) = oneshot::channel();
        if let Some(awaited) = locked(&self.awaited).as_mut() {
            awaited.insert(
                correlation_id.to_owned(),
                Awaited {
                    channels: reply_channels.iter().map(|c| (*c).to_owned()).collect(),
                    reply,
                },
            );
        }
        PendingReply {
            router: self.clone(),
            correlation_id: correlation_id.to_owned(),
            receiver,
        }
    }

    /// Hand `frame` to the request that awaits it, if one does.
    pub fn route(&self, frame: &Frame) {
        let Some(correlation_id) = &frame.correlation_id else {
            return;
        };
        let mut awaited = locked(&self.awaited);
        let Some(awaited) = awaited.as_mut() else {
            return;
        };
        if awaited
            .get(correlation_id)
            .is_some_and(|a| a.channels.contains(&frame.channel))
            && let Some(request) = awaited.remove(correlation_id)
        {
            let _ = request.reply.send(frame.clone());
        }
    }

    /// The correlation ids still awaited, in name order.
    pub fn awaited(&self) -> Vec<String> {
        let mut ids: Vec<String> = locked(&self.awaited)
            .as_ref()
            .map(|awaited| awaited.keys().cloned().collect())
            .unwrap_or_default();
        ids.sort();
        ids
    }

    /// End every wait: each request still pending learns no reply will come.
    pub fn close(&self) {
        *locked(&self.awaited) = None;
    }
}

/// A reply a request awaits. Dropping it stops the wait: the transport names
/// the reply no more, and one that comes anyway reaches nobody.
pub struct PendingReply {
    router: Arc<ReplyRouter>,
    correlation_id: String,
    receiver: oneshot::Receiver<Frame>,
}

impl PendingReply {
    /// The reply; `None` when the transport closed before one came.
    pub async fn frame(&mut self) -> Option<Frame> {
        (&mut self.receiver).await.ok()
    }
}

impl Drop for PendingReply {
    fn drop(&mut self) {
        if let Some(awaited) = locked(&self.router.awaited).as_mut() {
            awaited.remove(&self.correlation_id);
        }
    }
}

// ── Scopes ──────────────────────────────────────────────────────────────

/// One hold on a resource's scope (`Transport::subscribe_to_resource`),
/// let go when it is dropped.
pub struct ResourceHold {
    release: Option<Box<dyn FnOnce() + Send + Sync>>,
}

impl ResourceHold {
    pub fn new(release: impl FnOnce() + Send + Sync + 'static) -> ResourceHold {
        ResourceHold {
            release: Some(Box::new(release)),
        }
    }
}

impl Drop for ResourceHold {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            release();
        }
    }
}

// ── Transport ───────────────────────────────────────────────────────────

/// The bus, over whatever carries it.
pub trait Transport: Send + Sync + 'static {
    /// What the transport speaks to: an origin over HTTP, an opaque name for
    /// one with no wire.
    fn base_url(&self) -> &str;

    /// Send one frame. Resolves when it has been accepted, with the number of
    /// subscribers it reached, or with `None` when there is no count: an
    /// absent count is never a zero.
    fn emit<'a>(
        &'a self,
        channel: &'a str,
        payload: Map<String, Value>,
        envelope: Envelope,
    ) -> BoxFuture<'a, Result<Option<u64>, TransportError>>;

    /// The frames delivered on `channel` from now on. Refused, as
    /// `bus.unsubscribed`, for a channel this transport can never deliver.
    fn frames(&self, channel: &str) -> Result<Frames, BusRequestError>;

    /// Whether the transport's stream delivers `channel` globally: whether a
    /// reply published there can reach this client.
    fn is_subscribed(&self, channel: &str) -> bool;

    /// Take one hold on a resource's scope. The scope is on the stream from
    /// its first hold to its last release; holds are counted per resource.
    fn subscribe_to_resource(&self, resource_id: &ResourceId) -> ResourceHold;

    /// The connection's state: the current value, and each change after it.
    fn state(&self) -> watch::Receiver<ConnectionState>;

    /// The failures the transport meets, from now on.
    fn failures(&self) -> Failures;

    /// Await the reply to `correlation_id` on one of `reply_channels`. A
    /// request calls this before it emits, so its reply cannot arrive
    /// unawaited.
    fn track_reply(&self, correlation_id: &str, reply_channels: &[&str]) -> PendingReply;

    /// Publish into `bus` every frame this transport delivers. The bus is
    /// its client's: a transport never constructs or replaces one.
    fn bridge_into(&self, bus: Arc<EventBus>);

    /// Stop: the state becomes `Closed`, every stream ends, and every request
    /// still pending fails as closed. Closing twice is closing once.
    fn close(&self) -> BoxFuture<'_, ()>;

    /// The payloads delivered on `channel` from now on.
    fn stream(&self, channel: &str) -> Result<Payloads, BusRequestError> {
        Ok(Payloads {
            frames: self.frames(channel)?,
        })
    }

    /// Run `handler` on each payload delivered on `channel`, until the
    /// returned subscription is dropped. A handler that falls behind is not
    /// told what it missed; a reader that must know reads `frames`.
    fn on(
        &self,
        channel: &str,
        mut handler: Box<dyn FnMut(Map<String, Value>) + Send>,
    ) -> Result<Subscription, BusRequestError> {
        let mut frames = self.frames(channel)?;
        Ok(Subscription {
            task: tokio::spawn(async move {
                while let Some(item) = frames.next().await {
                    if let Ok(frame) = item {
                        handler(frame.payload);
                    }
                }
            }),
        })
    }
}

/// The payloads delivered on one channel: `Frames`, without the envelopes.
pub struct Payloads {
    frames: Frames,
}

impl Payloads {
    pub async fn next(&mut self) -> Option<Result<Map<String, Value>, Lagged>> {
        self.frames
            .next()
            .await
            .map(|item| item.map(|frame| frame.payload))
    }
}

impl Stream for Payloads {
    type Item = Result<Map<String, Value>, Lagged>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.frames)
            .poll_next(cx)
            .map(|item| item.map(|item| item.map(|frame| frame.payload)))
    }
}

/// The refusal a transport gives for a channel it can never deliver.
pub fn unsubscribed(channel: &str) -> BusRequestError {
    BusRequestError::new(
        BusRequestErrorCode::Unsubscribed,
        format!(
            "Transport is not subscribed to {channel}: a frame on it can never arrive on this connection. Add the channel to this client's channels."
        ),
    )
}

// ── Content ─────────────────────────────────────────────────────────────

/// An upload: the bytes, and each field the resource is created with.
#[derive(Debug, Clone, PartialEq)]
pub struct PutBinaryRequest {
    pub name: String,
    pub bytes: Bytes,
    /// The media type of the bytes.
    pub format: String,
    pub storage_uri: String,
    pub entity_types: Vec<String>,
    pub language: Option<String>,
    pub source_annotation_id: Option<AnnotationId>,
    pub source_resource_id: Option<ResourceId>,
    pub generation_prompt: Option<String>,
    /// The agent or agents that generated it, as the schema's `Agent`.
    pub generator: Option<Value>,
    /// The job this resource fulfils, when a worker is creating it.
    pub job_id: Option<JobId>,
    pub is_draft: Option<bool>,
    /// A clone's provenance: with it, the resource is created as a clone.
    pub clone_token: Option<String>,
    /// Of a clone: archive the source once the clone exists.
    pub archive_original: Option<bool>,
}

impl PutBinaryRequest {
    /// An upload of `bytes`, of the media type `format`, as the resource
    /// `name` kept at `storage_uri`: what every upload states, and nothing
    /// else.
    pub fn new(
        name: impl Into<String>,
        bytes: Bytes,
        format: impl Into<String>,
        storage_uri: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            bytes,
            format: format.into(),
            storage_uri: storage_uri.into(),
            entity_types: Vec::new(),
            language: None,
            source_annotation_id: None,
            source_resource_id: None,
            generation_prompt: None,
            generator: None,
            job_id: None,
            is_draft: None,
            clone_token: None,
            archive_original: None,
        }
    }
}

/// How much of an upload has been sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadProgress {
    pub bytes_uploaded: u64,
    /// The size of the whole request body.
    pub total_bytes: u64,
}

/// An upload in flight. As a stream it gives its progress, and ends when the
/// upload has; awaited, it gives the id of the resource created. Dropped, it
/// is cancelled: nothing more is sent.
pub struct Upload {
    progress: mpsc::UnboundedReceiver<UploadProgress>,
    sending: Option<BoxFuture<'static, Result<CreateResourceResponse, TransportError>>>,
    outcome: Option<Result<CreateResourceResponse, TransportError>>,
}

impl Upload {
    /// An upload `sending` performs, reporting its progress to the sender
    /// `progress` is the other end of.
    pub fn new(
        progress: mpsc::UnboundedReceiver<UploadProgress>,
        sending: BoxFuture<'static, Result<CreateResourceResponse, TransportError>>,
    ) -> Upload {
        Upload {
            progress,
            sending: Some(sending),
            outcome: None,
        }
    }

    fn drive(&mut self, cx: &mut Context<'_>) {
        if let Some(sending) = self.sending.as_mut()
            && let Poll::Ready(outcome) = sending.as_mut().poll(cx)
        {
            self.outcome = Some(outcome);
            self.sending = None;
        }
    }
}

impl Stream for Upload {
    type Item = UploadProgress;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.drive(cx);
        match self.progress.poll_recv(cx) {
            Poll::Ready(Some(progress)) => Poll::Ready(Some(progress)),
            Poll::Ready(None) => Poll::Ready(None),
            // What `sending` reported before it finished has been given, and
            // it will report no more.
            Poll::Pending if self.sending.is_none() => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl IntoFuture for Upload {
    type Output = Result<CreateResourceResponse, TransportError>;
    type IntoFuture = BoxFuture<'static, Self::Output>;

    fn into_future(mut self) -> Self::IntoFuture {
        Box::pin(async move {
            std::future::poll_fn(|cx| {
                self.drive(cx);
                match self.outcome.take() {
                    Some(outcome) => Poll::Ready(outcome),
                    None => Poll::Pending,
                }
            })
            .await
        })
    }
}

/// A resource's bytes, with their media type.
#[derive(Debug, Clone, PartialEq)]
pub struct Content {
    pub bytes: Bytes,
    pub content_type: String,
}

/// A resource's bytes as they arrive, with their media type.
pub struct ContentStream {
    pub bytes: Pin<Box<dyn Stream<Item = Result<Bytes, TransportError>> + Send>>,
    pub content_type: String,
}

/// Bytes, which never ride the bus, and a resource's description as linked
/// data.
pub trait ContentTransport: Send + Sync + 'static {
    /// Upload `request`'s bytes as a new resource.
    fn put_binary(&self, request: PutBinaryRequest) -> Upload;

    /// A resource's bytes, unchanged, with their media type.
    fn get_binary<'a>(
        &'a self,
        resource_id: &'a ResourceId,
    ) -> BoxFuture<'a, Result<Content, TransportError>>;

    /// The same, as a stream.
    fn get_binary_stream<'a>(
        &'a self,
        resource_id: &'a ResourceId,
    ) -> BoxFuture<'a, Result<ContentStream, TransportError>>;

    /// A resource's description: itself, its annotations and the references
    /// to it, as linked data.
    fn get_resource_graph<'a>(
        &'a self,
        resource_id: &'a ResourceId,
    ) -> BoxFuture<'a, Result<GetResourceResponse, TransportError>>;
}

// ── The gateway's own operations ────────────────────────────────────────

/// What a gateway answers for itself.
pub trait GatewayOperations: Send + Sync + 'static {
    fn get_current_user(&self) -> BoxFuture<'_, Result<UserResponse, TransportError>>;

    /// A token that lets a browser fetch one resource's bytes.
    fn get_media_token<'a>(
        &'a self,
        resource_id: &'a ResourceId,
    ) -> BoxFuture<'a, Result<MediaTokenResponse, TransportError>>;

    /// Which issuer the knowledge base trusts (RFC 9728). Public: read before
    /// any token exists.
    fn get_protected_resource_metadata(
        &self,
    ) -> BoxFuture<'_, Result<ProtectedResourceMetadata, TransportError>>;

    fn health_check(&self) -> BoxFuture<'_, Result<HealthResponse, TransportError>>;

    fn get_status(&self) -> BoxFuture<'_, Result<StatusResponse, TransportError>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(channel: &str, correlation_id: Option<&str>) -> Frame {
        Frame {
            channel: channel.to_owned(),
            payload: Map::new(),
            correlation_id: correlation_id.map(str::to_owned),
            scope: None,
            trace: None,
        }
    }

    #[tokio::test]
    async fn a_reader_of_one_channel_is_not_lagged_by_another() {
        let hub = FrameHub::new();
        let mut quiet = hub.frames("quiet");
        let _busy = hub.frames("busy");
        for _ in 0..(STREAM_BACKLOG * 3) {
            hub.deliver(frame("busy", None));
        }
        hub.deliver(frame("quiet", None));
        assert_eq!(quiet.next().await, Some(Ok(frame("quiet", None))));
    }

    #[tokio::test]
    async fn a_reader_that_fell_behind_is_told_how_far() {
        let hub = FrameHub::new();
        let mut frames = hub.frames("busy");
        for _ in 0..(STREAM_BACKLOG + 5) {
            hub.deliver(frame("busy", None));
        }
        assert_eq!(frames.next().await, Some(Err(Lagged(5))));
        assert!(matches!(frames.next().await, Some(Ok(_))));
    }

    #[tokio::test]
    async fn a_closed_hub_ends_every_stream() {
        let hub = FrameHub::new();
        let mut before = hub.frames("a");
        hub.close();
        assert_eq!(before.next().await, None);
        assert_eq!(hub.frames("a").next().await, None);
    }

    #[tokio::test]
    async fn a_reply_reaches_the_request_that_awaits_it_and_no_other() {
        let router = ReplyRouter::new();
        let mut mine = router.track("cid-1", &["result", "failure"]);
        let mut theirs = router.track("cid-2", &["result", "failure"]);
        assert_eq!(router.awaited(), ["cid-1", "cid-2"]);

        // The same id on a channel that is not its reply's settles nothing.
        router.route(&frame("progress", Some("cid-1")));
        router.route(&frame("result", Some("cid-1")));
        assert_eq!(mine.frame().await, Some(frame("result", Some("cid-1"))));
        assert_eq!(router.awaited(), ["cid-2"]);

        router.close();
        assert_eq!(theirs.frame().await, None);
    }

    #[tokio::test]
    async fn a_dropped_wait_is_named_no_more() {
        let router = ReplyRouter::new();
        let pending = router.track("cid-1", &["result"]);
        drop(pending);
        assert!(router.awaited().is_empty());
    }

    #[tokio::test]
    async fn a_hold_is_released_once_when_dropped() {
        let released = Arc::new(Mutex::new(0));
        let count = released.clone();
        let hold = ResourceHold::new(move || *locked(&count) += 1);
        drop(hold);
        assert_eq!(*locked(&released), 1);
    }
}
