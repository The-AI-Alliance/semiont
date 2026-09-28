//! The NATS plane. Every frame rides a core subject, and nothing published on
//! the plane is captured; the one use of JetStream is the shared tables,
//! key-value buckets that hold the ledger's own bookkeeping.
//!
//! The subjects, private to the gateway (one cutover, no mixed fleet):
//!
//!   global channel   sig.chan.<channel, ':' → '.'>
//!   scoped channel   sig.scope.<base64url(scope)>.<channel, ':' → '.'>
//!
//! A channel name carries no dots, wildcards or whitespace; a scope can carry
//! anything, so it rides encoded whole.

use super::{
    ClientSubscription, Frame, IngestReceipt, Meta, SharedTable, SignalPlane, Subscription,
    Unavailable,
};
use crate::logging;
use async_nats::connection::State;
use async_nats::jetstream::{self, kv};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use futures::future::BoxFuture;
use futures::{FutureExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const PREFIX: &str = "sig.";

fn b64url(raw: &str) -> String {
    URL_SAFE_NO_PAD.encode(raw.as_bytes())
}

fn from_b64url(encoded: &str) -> Option<String> {
    String::from_utf8(URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()
}

fn channel_token(channel: &str) -> Result<String, String> {
    if channel
        .chars()
        .any(|c| c == '.' || c == '*' || c == '>' || c.is_whitespace())
    {
        return Err(format!(
            "signal/nats: channel \"{channel}\" cannot map onto a subject token"
        ));
    }
    Ok(channel.replace(':', "."))
}

fn channel_subject(channel: &str) -> Result<String, String> {
    Ok(format!("{PREFIX}chan.{}", channel_token(channel)?))
}

fn scoped_subject(scope: &str, channel: &str) -> Result<String, String> {
    Ok(format!(
        "{PREFIX}scope.{}.{}",
        b64url(scope),
        channel_token(channel)?
    ))
}

/// A frame as it travels: routing metadata beside the payload.
#[derive(Serialize, Deserialize)]
struct Wire {
    #[serde(skip_serializing_if = "Option::is_none")]
    meta: Option<Meta>,
    payload: Value,
}

pub struct NatsPlane {
    client: async_nats::Client,
}

impl NatsPlane {
    /// Connect, retrying for as long as the broker is unreachable once
    /// connected; the first connection must succeed.
    pub async fn connect(
        servers: &str,
        user: Option<String>,
        password: Option<String>,
    ) -> Result<NatsPlane, String> {
        let reconnecting = Arc::new(AtomicBool::new(false));
        let watched = servers.to_owned();
        let mut options = async_nats::ConnectOptions::new().max_reconnects(None).event_callback(move |event| {
            let servers = watched.clone();
            let reconnecting = reconnecting.clone();
            async move {
                match event {
                    async_nats::Event::Disconnected => {
                        reconnecting.store(true, Ordering::SeqCst);
                        logging::warn(
                            "[signal BROKER-DOWN] NATS connection lost; emits are refused until it is restored",
                            json!({ "component": "signal", "servers": servers }),
                        );
                    }
                    async_nats::Event::Connected if reconnecting.swap(false, Ordering::SeqCst) => {
                        logging::info("[signal BROKER-RECONNECTED] NATS connection restored", json!({ "component": "signal", "servers": servers }));
                    }
                    async_nats::Event::ServerError(error) => {
                        logging::error("[signal BROKER-REFUSED] the broker refused the gateway", json!({ "component": "signal", "servers": servers, "reason": error.to_string() }));
                    }
                    _ => {}
                }
            }
        });
        if user.is_some() || password.is_some() {
            options =
                options.user_and_password(user.unwrap_or_default(), password.unwrap_or_default());
        }
        let client = options
            .connect(servers)
            .await
            .map_err(|e| format!("cannot connect to the NATS broker at {servers}: {e}"))?;
        Ok(NatsPlane { client })
    }
}

fn decode(payload: &[u8]) -> Option<Wire> {
    let wire = serde_json::from_slice::<Wire>(payload).ok();
    if wire.is_none() {
        logging::warn(
            "[signal FRAME-MALFORMED] a message with no frame shape dropped",
            json!({ "component": "signal" }),
        );
    }
    wire
}

impl SignalPlane for NatsPlane {
    fn available(&self) -> bool {
        self.client.connection_state() == State::Connected
    }

    fn ingest(
        &self,
        channel: String,
        payload: Value,
        scope: Option<String>,
        meta: Option<Meta>,
    ) -> BoxFuture<'_, Result<IngestReceipt, Unavailable>> {
        async move {
            if !self.available() {
                return Err(Unavailable);
            }
            let subject = match &scope {
                Some(scope) => scoped_subject(scope, &channel),
                None => channel_subject(&channel),
            }
            .unwrap_or_else(|e| panic!("{e}"));
            let bytes = serde_json::to_vec(&Wire { meta, payload }).expect("a frame serializes");
            self.client
                .publish(subject, Bytes::from(bytes))
                .await
                .map_err(|_| Unavailable)?;
            // A broker cannot count who heard it.
            Ok(IngestReceipt { observers: None })
        }
        .boxed()
    }

    fn subscribe_client(
        &self,
        subscription: ClientSubscription,
    ) -> BoxFuture<'_, Result<Subscription, String>> {
        async move {
            let mut routes: Vec<(String, Option<String>, String)> = Vec::new();
            for channel in &subscription.global {
                routes.push((channel_subject(channel)?, None, channel.clone()));
            }
            for entry in &subscription.scoped {
                for channel in &entry.channels {
                    routes.push((
                        scoped_subject(&entry.scope, channel)?,
                        Some(entry.scope.clone()),
                        channel.clone(),
                    ));
                }
            }
            let mut streams = Vec::with_capacity(routes.len());
            for (subject, scope, channel) in routes {
                let subscriber = self
                    .client
                    .subscribe(subject)
                    .await
                    .map_err(|e| e.to_string())?;
                streams.push(
                    subscriber
                        .map(move |message| (scope.clone(), channel.clone(), message))
                        .boxed(),
                );
            }
            let on_frame = subscription.on_frame;
            let pump = tokio::spawn(async move {
                let mut merged = futures::stream::select_all(streams);
                while let Some((scope, channel, message)) = merged.next().await {
                    if let Some(wire) = decode(&message.payload) {
                        on_frame(Frame {
                            channel,
                            payload: Arc::new(wire.payload),
                            scope,
                            meta: wire.meta,
                        });
                    }
                }
            });
            Ok(Subscription::new(move || pump.abort()))
        }
        .boxed()
    }

    fn flush(&self) -> BoxFuture<'_, Result<(), String>> {
        // One round trip through the broker: a request nobody answers comes
        // back "no responders" once the broker has read everything this
        // connection wrote before it — subscriptions included.
        async move {
            match self
                .client
                .request(format!("{PREFIX}flush"), Bytes::new())
                .await
            {
                Ok(_) => Ok(()),
                Err(error) if error.kind() == async_nats::RequestErrorKind::NoResponders => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        }
        .boxed()
    }

    fn table(
        &self,
        name: String,
        ttl: Duration,
    ) -> BoxFuture<'_, Result<Arc<dyn SharedTable>, String>> {
        async move {
            let context = jetstream::new(self.client.clone());
            let store = context
                .create_or_update_key_value(kv::Config {
                    bucket: name.clone(),
                    history: 1,
                    max_age: ttl,
                    ..Default::default()
                })
                .await
                .map_err(|e| {
                    format!(
                        "the broker would not open the table {name}: {}",
                        logging::chain(&e)
                    )
                })?;
            let table: Arc<dyn SharedTable> = Arc::new(NatsTable { store });
            Ok(table)
        }
        .boxed()
    }
}

/// A key-value bucket. Keys ride encoded whole: a bucket key allows a narrow
/// alphabet, and what the ledger keys by must not have to fit it.
struct NatsTable {
    store: kv::Store,
}

impl SharedTable for NatsTable {
    fn create(&self, key: String, value: String) -> BoxFuture<'_, Result<bool, String>> {
        async move {
            match self.store.create(b64url(&key), Bytes::from(value)).await {
                Ok(_) => Ok(true),
                Err(error) if error.kind() == kv::CreateErrorKind::AlreadyExists => Ok(false),
                Err(error) => Err(logging::chain(&error)),
            }
        }
        .boxed()
    }

    fn read(&self, key: String) -> BoxFuture<'_, Result<Option<String>, String>> {
        async move {
            let value = self
                .store
                .get(b64url(&key))
                .await
                .map_err(|e| logging::chain(&e))?;
            Ok(value.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
        }
        .boxed()
    }

    fn watch(
        &self,
        on_entry: Arc<dyn Fn(String, String) + Send + Sync>,
    ) -> BoxFuture<'_, Result<Subscription, String>> {
        async move {
            // Everything after the bucket's last sequence arrives on the watch;
            // everything up to it is read key by key. An entry both see is
            // delivered twice, which a watcher takes as once.
            let last = self
                .store
                .stream
                .get_info()
                .await
                .map_err(|e| logging::chain(&e))?
                .state
                .last_sequence;
            let mut entries = self
                .store
                .watch_all_from_revision(last + 1)
                .await
                .map_err(|e| logging::chain(&e))?;
            let live = on_entry.clone();
            let pump = tokio::spawn(async move {
                while let Some(Ok(entry)) = entries.next().await {
                    if entry.operation == kv::Operation::Put
                        && let Some(key) = from_b64url(&entry.key)
                    {
                        live(key, String::from_utf8_lossy(&entry.value).into_owned());
                    }
                }
            });
            let mut keys = self.store.keys().await.map_err(|e| logging::chain(&e))?;
            while let Some(key) = keys.next().await {
                let key = key.map_err(|e| logging::chain(&e))?;
                if let Some(value) = self
                    .store
                    .get(key.clone())
                    .await
                    .map_err(|e| logging::chain(&e))?
                    && let Some(decoded) = from_b64url(&key)
                {
                    on_entry(decoded, String::from_utf8_lossy(&value).into_owned());
                }
            }
            Ok(Subscription::new(move || pump.abort()))
        }
        .boxed()
    }
}
