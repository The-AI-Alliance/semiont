//! The signal plane: the gateway's hub role as one interface with two
//! implementations — `nats`, the fabric every replica on one broker shares,
//! and `in_process`, one gateway on its own. A caller cannot tell which is
//! installed except by `IngestReceipt::observers`, which only a fabric that
//! can count reports.
//!
//! It moves frames and never reads one: a frame's `scope` is the one routing
//! fact a plane interprets, and its `meta` (the correlation id, the trace) is
//! carried verbatim. Entitlement is the ledger's (crate::ledger), above it.
//! Delivery is at most once, in order per channel and scope.

pub mod in_process;
pub mod nats;

use futures::future::BoxFuture;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Routing facts that ride beside a payload, carried verbatim.
pub type Meta = HashMap<String, String>;

/// One frame as a plane delivers it.
#[derive(Debug, Clone)]
pub struct Frame {
    pub channel: String,
    pub payload: Arc<Value>,
    pub scope: Option<String>,
    pub meta: Option<Meta>,
}

pub type OnFrame = Arc<dyn Fn(Frame) + Send + Sync>;

pub struct ScopedChannels {
    pub scope: String,
    pub channels: Vec<String>,
}

/// A client-mode subscription: every frame on these channels and scopes.
pub struct ClientSubscription {
    pub global: Vec<String>,
    pub scoped: Vec<ScopedChannels>,
    pub on_frame: OnFrame,
}

/// Holds a subscription open; dropping it, or `close`, ends it.
pub struct Subscription {
    end: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Subscription {
    pub fn new(end: impl FnOnce() + Send + 'static) -> Subscription {
        Subscription {
            end: Mutex::new(Some(Box::new(end))),
        }
    }

    pub fn close(&self) {
        let end = self.end.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(end) = end {
            end();
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.close();
    }
}

/// The plane cannot carry a frame now: its broker connection is down, or
/// closed for good. A frame handed to a disconnected client would be lost,
/// so it is refused instead.
#[derive(Debug, Clone, Copy)]
pub struct Unavailable;

impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "The signal plane is unavailable: its broker is not connected"
        )
    }
}

/// What an ingest learned: how many subscriptions its channel and scope had
/// at dispatch, when the fabric can count them. A broker cannot count, and
/// reports nothing rather than a number it never observed, save the zero
/// `ingest_request` observes: the broker's own answer that nothing subscribes.
pub struct IngestReceipt {
    pub observers: Option<usize>,
}

/// A table every replica on one fabric shares. An entry lives for the table's
/// TTL from when it was last written, and is then gone. Keys and values are
/// opaque strings.
pub trait SharedTable: Send + Sync {
    /// Insert `key` unless present: true once the fabric holds it, false when it was there.
    fn create(&self, key: String, value: String) -> BoxFuture<'_, Result<bool, String>>;
    /// Set `key` whether or not it is present, its TTL starting again.
    fn put(&self, key: String, value: String) -> BoxFuture<'_, Result<(), String>>;
    /// Remove `key`, if present.
    fn delete(&self, key: String) -> BoxFuture<'_, Result<(), String>>;
    /// The authoritative value, if present.
    fn read(&self, key: String) -> BoxFuture<'_, Result<Option<String>, String>>;
    /// Every entry present, then every change after: `Some(value)` for an
    /// entry written, `None` for one deleted. An entry that expires is not
    /// reported; a watcher that cares keeps its own clock. Resolves once the
    /// present ones have been delivered.
    fn watch(&self, on_change: TableWatcher) -> BoxFuture<'_, Result<Subscription, String>>;
}

/// What a table's watch calls with each change: the key, and its value or `None` when deleted.
pub type TableWatcher = Arc<dyn Fn(String, Option<String>) + Send + Sync>;

pub trait SignalPlane: Send + Sync {
    /// Whether a frame ingested now would reach the fabric.
    fn available(&self) -> bool;
    /// Publish a frame. Refused when `available()` is false.
    fn ingest(
        &self,
        channel: String,
        payload: Value,
        scope: Option<String>,
        meta: Option<Meta>,
    ) -> BoxFuture<'_, Result<IngestReceipt, Unavailable>>;
    /// Publish a request whose operation fails when nobody receives it: as
    /// `ingest`, but the receipt reports `Some(0)` wherever the fabric can
    /// observe that no subscription received the frame, a broker included.
    /// It costs a broker a round trip, so only a request the gateway answers
    /// for when it reaches nobody asks for it.
    fn ingest_request(
        &self,
        channel: String,
        payload: Value,
        scope: Option<String>,
        meta: Option<Meta>,
    ) -> BoxFuture<'_, Result<IngestReceipt, Unavailable>>;
    /// Every frame on the subscription's channels and scopes, until the
    /// returned handle closes. Registered with the fabric once `flush` has resolved after it.
    fn subscribe_client(
        &self,
        subscription: ClientSubscription,
    ) -> BoxFuture<'_, Result<Subscription, String>>;
    /// Resolves once everything already issued on this plane's connection
    /// has been processed by the fabric: after it, a subscription made before
    /// it receives every frame published after. Delivery, durability and
    /// ordering across connections are not what it says.
    fn flush(&self) -> BoxFuture<'_, Result<(), String>>;
    /// The table named `name`. Every handle on one name has the same TTL.
    fn table(
        &self,
        name: String,
        ttl: Duration,
    ) -> BoxFuture<'_, Result<Arc<dyn SharedTable>, String>>;
}
