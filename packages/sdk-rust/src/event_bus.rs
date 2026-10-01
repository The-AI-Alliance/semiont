//! A client's own bus: frames published and observed inside one process. A
//! client constructs one and hands it to its transport (`bridge_into`), which
//! publishes into it every frame it delivers; what the client's own parts
//! say to each other goes through it too.
//!
//! A frame is published globally or into one resource's scope, and a view
//! sees one or the other: the global view of a channel does not see a frame
//! published into a scope, and a scope's view sees only its own.

use crate::transport::{Envelope, Events, Frame, Lagged, STREAM_BACKLOG};
use futures_core::Stream;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};
use tokio::sync::broadcast;

/// A view's key: the channel, and the scope it sees.
type View = (String, Option<String>);

struct Channels {
    frames: HashMap<String, broadcast::Sender<Frame>>,
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
        if let Some(sender) = channels.frames.get(channel) {
            let _ = sender.send(Frame {
                channel: channel.to_owned(),
                payload,
                correlation_id: envelope.correlation_id,
                scope: envelope.scope,
                trace: None,
            });
        }
        observers
    }

    fn frames(self: &Arc<Self>, channel: &str, scope: Option<String>) -> BusFrames {
        let view = (channel.to_owned(), scope);
        let mut channels = self.channels();
        let events = match channels.as_mut() {
            Some(channels) => {
                *channels.observers.entry(view.clone()).or_insert(0) += 1;
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
            view,
            events,
        }
    }
}

/// The frames of one view: a channel's, globally or in one scope.
pub struct BusFrames {
    bus: Arc<Inner>,
    view: View,
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
                Poll::Ready(Some(Ok(frame))) if frame.scope != self.view.1 => continue,
                other => return other,
            }
        }
    }
}

impl Drop for BusFrames {
    fn drop(&mut self) {
        if let Some(channels) = self.bus.channels().as_mut()
            && let Some(count) = channels.observers.get_mut(&self.view)
        {
            *count = count.saturating_sub(1);
            if *count == 0 {
                channels.observers.remove(&self.view);
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

    /// This bus, seen from one resource's scope.
    pub fn scope(&self, resource_id: &str) -> ScopedEventBus {
        ScopedEventBus {
            inner: self.inner.clone(),
            scope: resource_id.to_owned(),
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
    scope: String,
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

    /// A scope within this one.
    pub fn scope(&self, within: &str) -> ScopedEventBus {
        ScopedEventBus {
            inner: self.inner.clone(),
            scope: format!("{}:{within}", self.scope),
        }
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
        let mut one = bus.scope("res-1").frames("mark:added");
        let mut other = bus.scope("res-2").frames("mark:added");

        assert_eq!(bus.emit("mark:added", payload(1), Envelope::default()), 1);
        assert_eq!(bus.scope("res-1").emit("mark:added", payload(2), None), 1);
        assert_eq!(bus.scope("res-3").emit("mark:added", payload(3), None), 0);
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
    async fn a_destroyed_bus_is_inert() {
        let bus = EventBus::new();
        bus.destroy();
        bus.destroy();
        assert!(bus.destroyed());
        assert_eq!(bus.emit("beckon:focus", payload(1), Envelope::default()), 0);
        assert_eq!(bus.frames("beckon:focus").next().await, None);
    }
}
