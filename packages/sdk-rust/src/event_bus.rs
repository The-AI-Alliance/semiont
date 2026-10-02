//! A client's own bus: frames published and observed inside one process. A
//! client constructs one and hands it to its transport (`bridge_into`), which
//! publishes into it every frame it delivers; what the client's own parts
//! say to each other goes through it too.
//!
//! A frame is published globally or into one resource's scope, and a view
//! sees one or the other: the global view of a channel does not see a frame
//! published into a scope, and a scope's view sees only its own.
//!
//! A view of one channel gives its frames in the order they were published.
//! Two views give no order between them, so a reader of several channels
//! that needs what was said in the order it was said takes one view of them
//! all (`frames_among`).
//!
//! By type (`publish`, `stream`), the channel is a type of `crate::channels`
//! and the payload is that channel's own, as on `crate::bus::Bus`.

use crate::bus::{Typed, payload_of};
use crate::channels::Channel;
use crate::errors::TransportError;
use crate::transport::{Envelope, Events, Frame, Lagged, STREAM_BACKLOG};
use crate::types::ResourceId;
use futures_core::Stream;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};
use tokio::sync::broadcast;

/// A view's key: the channel, and the scope it sees.
type View = (String, Option<ResourceId>);

struct Channels {
    frames: HashMap<String, broadcast::Sender<Frame>>,
    /// The views of several channels at once, each with the channels it sees.
    among: Vec<(Vec<String>, broadcast::Sender<Frame>)>,
    /// How many readers each view has: what `emit` reports.
    observers: HashMap<View, usize>,
}

struct Inner {
    /// `None` once destroyed.
    channels: Mutex<Option<Channels>>,
}

impl Inner {
    fn channels(&self) -> MutexGuard<'_, Option<Channels>> {
        self.channels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn emit(&self, channel: &str, payload: Map<String, Value>, envelope: Envelope) -> usize {
        let mut channels = self.channels();
        let Some(channels) = channels.as_mut() else {
            return 0;
        };
        let observers = channels
            .observers
            .get(&(channel.to_owned(), envelope.scope.clone()))
            .copied()
            .unwrap_or(0);
        let frame = Frame {
            channel: channel.to_owned(),
            payload,
            correlation_id: envelope.correlation_id,
            scope: envelope.scope,
            trace: None,
        };
        for (seen, sender) in &channels.among {
            if seen.iter().any(|one| one == channel) {
                let _ = sender.send(frame.clone());
            }
        }
        if let Some(sender) = channels.frames.get(channel) {
            let _ = sender.send(frame);
        }
        observers
    }

    fn frames(self: &Arc<Self>, channel: &str, scope: Option<ResourceId>) -> BusFrames {
        let views = vec![(channel.to_owned(), scope.clone())];
        let mut channels = self.channels();
        let events = match channels.as_mut() {
            Some(channels) => {
                *channels.observers.entry(views[0].clone()).or_insert(0) += 1;
                Events::new(
                    channels
                        .frames
                        .entry(channel.to_owned())
                        .or_insert_with(|| broadcast::channel(STREAM_BACKLOG).0)
                        .subscribe(),
                )
            }
            None => Events::new(broadcast::channel(1).1),
        };
        BusFrames {
            bus: self.clone(),
            views,
            scope,
            events,
        }
    }

    fn frames_among(self: &Arc<Self>, among: &[&str]) -> BusFrames {
        let seen: Vec<String> = among.iter().map(|channel| (*channel).to_owned()).collect();
        let views: Vec<View> = seen.iter().map(|channel| (channel.clone(), None)).collect();
        let mut channels = self.channels();
        let events = match channels.as_mut() {
            Some(channels) => {
                for view in &views {
                    *channels.observers.entry(view.clone()).or_insert(0) += 1;
                }
                // A view nobody reads any more is let go here, where the
                // next one is made.
                channels
                    .among
                    .retain(|(_, sender)| sender.receiver_count() > 0);
                let (sender, receiver) = broadcast::channel(STREAM_BACKLOG);
                channels.among.push((seen, sender));
                Events::new(receiver)
            }
            None => Events::new(broadcast::channel(1).1),
        };
        BusFrames {
            bus: self.clone(),
            views,
            scope: None,
            events,
        }
    }
}

/// The frames of one view: a channel's, or several channels', globally or in
/// one scope.
pub struct BusFrames {
    bus: Arc<Inner>,
    /// What it reads, for the count `emit` reports.
    views: Vec<View>,
    scope: Option<ResourceId>,
    events: Events<Frame>,
}

impl BusFrames {
    pub async fn next(&mut self) -> Option<Result<Frame, Lagged>> {
        std::future::poll_fn(|cx| Pin::new(&mut *self).poll_next(cx)).await
    }
}

impl Stream for BusFrames {
    type Item = Result<Frame, Lagged>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            match Pin::new(&mut self.events).poll_next(cx) {
                Poll::Ready(Some(Ok(frame))) if frame.scope != self.scope => continue,
                other => return other,
            }
        }
    }
}

impl Drop for BusFrames {
    fn drop(&mut self) {
        let mut channels = self.bus.channels();
        let Some(channels) = channels.as_mut() else {
            return;
        };
        for view in &self.views {
            if let Some(count) = channels.observers.get_mut(view) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    channels.observers.remove(view);
                }
            }
        }
    }
}

/// A client's own bus.
#[derive(Clone)]
pub struct EventBus {
    inner: Arc<Inner>,
}

impl Default for EventBus {
    fn default() -> EventBus {
        EventBus {
            inner: Arc::new(Inner {
                channels: Mutex::new(Some(Channels {
                    frames: HashMap::new(),
                    among: Vec::new(),
                    observers: HashMap::new(),
                })),
            }),
        }
    }
}

impl EventBus {
    pub fn new() -> EventBus {
        EventBus::default()
    }

    /// Publish a frame: globally, or into `envelope.scope`. How many readers
    /// its view had when it was published. A destroyed bus publishes nothing.
    pub fn emit(&self, channel: &str, payload: Map<String, Value>, envelope: Envelope) -> usize {
        self.inner.emit(channel, payload, envelope)
    }

    /// The frames published globally on `channel` from now on. A frame
    /// published into a resource's scope is not among them.
    pub fn frames(&self, channel: &str) -> BusFrames {
        self.inner.frames(channel, None)
    }

    /// The frames published globally on any of `channels` from now on, in
    /// the order they were published.
    pub fn frames_among(&self, channels: &[&str]) -> BusFrames {
        self.inner.frames_among(channels)
    }

    /// Publish one frame of the channel `C`, globally or into
    /// `envelope.scope`. How many readers its view had.
    pub fn publish<C: Channel>(
        &self,
        payload: &C::Payload,
        envelope: Envelope,
    ) -> Result<usize, TransportError> {
        Ok(self.emit(C::NAME, payload_of(payload)?, envelope))
    }

    /// The frames published globally on the channel `C` from now on, each
    /// with its payload decoded.
    pub fn stream<C: Channel>(&self) -> Typed<C, BusFrames> {
        Typed::of(self.frames(C::NAME))
    }

    /// This bus, seen from one resource's scope.
    pub fn scope(&self, resource_id: &ResourceId) -> ScopedEventBus {
        ScopedEventBus {
            inner: self.inner.clone(),
            scope: resource_id.clone(),
        }
    }

    /// The channels somebody is reading now, in name order.
    pub fn observed_channels(&self) -> Vec<String> {
        let mut observed: Vec<String> = self
            .inner
            .channels()
            .as_ref()
            .map(|channels| channels.observers.keys().map(|(c, _)| c.clone()).collect())
            .unwrap_or_default();
        observed.sort();
        observed.dedup();
        observed
    }

    /// End every view, and every one taken later. Destroying twice is
    /// destroying once.
    pub fn destroy(&self) {
        *self.inner.channels() = None;
    }

    pub fn destroyed(&self) -> bool {
        self.inner.channels().is_none()
    }
}

/// A bus seen from one resource's scope: what is published through it goes
/// into that scope, and its views see only that scope's frames.
#[derive(Clone)]
pub struct ScopedEventBus {
    inner: Arc<Inner>,
    scope: ResourceId,
}

impl ScopedEventBus {
    /// Publish into this scope, with `correlation_id` when the frame is a
    /// reply or a request.
    pub fn emit(
        &self,
        channel: &str,
        payload: Map<String, Value>,
        correlation_id: Option<String>,
    ) -> usize {
        self.inner.emit(
            channel,
            payload,
            Envelope {
                correlation_id,
                scope: Some(self.scope.clone()),
            },
        )
    }

    /// The frames published into this scope on `channel` from now on.
    pub fn frames(&self, channel: &str) -> BusFrames {
        self.inner.frames(channel, Some(self.scope.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload(n: u64) -> Map<String, Value> {
        json!({ "n": n }).as_object().cloned().unwrap_or_default()
    }

    #[tokio::test]
    async fn a_global_view_does_not_see_a_scope_and_a_scope_sees_only_its_own() {
        let bus = EventBus::new();
        let mut global = bus.frames("mark:added");
        let mut one = bus.scope(&"res-1".parse().unwrap()).frames("mark:added");
        let mut other = bus.scope(&"res-2".parse().unwrap()).frames("mark:added");

        assert_eq!(bus.emit("mark:added", payload(1), Envelope::default()), 1);
        assert_eq!(
            bus.scope(&"res-1".parse().unwrap())
                .emit("mark:added", payload(2), None),
            1
        );
        assert_eq!(
            bus.scope(&"res-3".parse().unwrap())
                .emit("mark:added", payload(3), None),
            0
        );
        bus.destroy();

        let seen = |frames: Vec<Frame>| -> Vec<Value> {
            frames.into_iter().map(|f| f.payload["n"].clone()).collect()
        };
        let mut drained = Vec::new();
        while let Some(Ok(frame)) = global.next().await {
            drained.push(frame);
        }
        assert_eq!(seen(drained), [json!(1)]);
        let mut drained = Vec::new();
        while let Some(Ok(frame)) = one.next().await {
            drained.push(frame);
        }
        assert_eq!(seen(drained), [json!(2)]);
        assert_eq!(other.next().await, None);
    }

    #[tokio::test]
    async fn the_count_follows_the_readers() {
        let bus = EventBus::new();
        assert_eq!(bus.emit("beckon:focus", payload(1), Envelope::default()), 0);
        let first = bus.frames("beckon:focus");
        let second = bus.frames("beckon:focus");
        assert_eq!(bus.emit("beckon:focus", payload(2), Envelope::default()), 2);
        assert_eq!(bus.observed_channels(), ["beckon:focus"]);
        drop(first);
        drop(second);
        assert_eq!(bus.emit("beckon:focus", payload(3), Envelope::default()), 0);
        assert!(bus.observed_channels().is_empty());
    }

    #[tokio::test]
    async fn a_view_of_several_channels_gives_them_in_the_order_they_were_published() {
        let bus = EventBus::new();
        let mut both = bus.frames_among(&["mark:requested", "mark:cancel-pending"]);
        assert_eq!(
            bus.observed_channels(),
            ["mark:cancel-pending", "mark:requested"]
        );

        for n in 0..6 {
            let channel = if n % 2 == 0 {
                "mark:requested"
            } else {
                "mark:cancel-pending"
            };
            assert_eq!(bus.emit(channel, payload(n), Envelope::default()), 1);
        }
        bus.emit("mark:submit", payload(9), Envelope::default());
        bus.scope(&"res-1".parse().unwrap())
            .emit("mark:requested", payload(9), None);
        drop(bus.frames_among(&["mark:requested"]));
        bus.destroy();

        let mut seen = Vec::new();
        while let Some(Ok(frame)) = both.next().await {
            seen.push((frame.channel, frame.payload["n"].clone()));
        }
        let said = |channel: &str, n: u64| (channel.to_owned(), json!(n));
        assert_eq!(
            seen,
            [
                said("mark:requested", 0),
                said("mark:cancel-pending", 1),
                said("mark:requested", 2),
                said("mark:cancel-pending", 3),
                said("mark:requested", 4),
                said("mark:cancel-pending", 5),
            ]
        );
    }

    #[tokio::test]
    async fn a_view_of_several_channels_is_counted_on_each_until_it_is_dropped() {
        let bus = EventBus::new();
        let both = bus.frames_among(&["beckon:hover", "browse:click"]);
        assert_eq!(bus.emit("beckon:hover", payload(1), Envelope::default()), 1);
        assert_eq!(bus.emit("browse:click", payload(2), Envelope::default()), 1);
        drop(both);
        assert_eq!(bus.emit("beckon:hover", payload(3), Envelope::default()), 0);
        assert!(bus.observed_channels().is_empty());
    }

    #[tokio::test]
    async fn a_destroyed_bus_is_inert() {
        let bus = EventBus::new();
        bus.destroy();
        bus.destroy();
        assert!(bus.destroyed());
        assert_eq!(bus.emit("beckon:focus", payload(1), Envelope::default()), 0);
        assert_eq!(bus.frames("beckon:focus").next().await, None);
        assert_eq!(bus.frames_among(&["beckon:focus"]).next().await, None);
    }
}
