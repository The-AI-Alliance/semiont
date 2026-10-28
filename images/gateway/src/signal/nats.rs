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
    TableWatcher, Unavailable, publish_id,
};
use async_nats::StatusCode;
use async_nats::connection::State;
use async_nats::jetstream::{self, kv};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use futures::future::BoxFuture;
use futures::{FutureExt, StreamExt};
use semiont_core::nats;
use semiont_observability::logging;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
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

/// A frame as it travels: its id and routing metadata beside the payload.
#[derive(Serialize, Deserialize)]
struct Wire {
    id: String,
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
        let client = nats::connect(
            servers,
            user,
            password,
            nats::Voice {
                tag: "signal",
                while_down: "emits are refused until it is restored",
                refused: "the gateway",
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(NatsPlane { client })
    }
}

/// A frame's subject and bytes on the broker.
fn message(
    channel: &str,
    payload: Value,
    scope: Option<&str>,
    meta: Option<Meta>,
) -> (String, Bytes) {
    let subject = match scope {
        Some(scope) => scoped_subject(scope, channel),
        None => channel_subject(channel),
    }
    .unwrap_or_else(|e| panic!("{e}"));
    let wire = Wire {
        id: publish_id(),
        meta,
        payload,
    };
    let bytes = serde_json::to_vec(&wire).expect("a frame serializes");
    (subject, Bytes::from(bytes))
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
            let (subject, bytes) = message(&channel, payload, scope.as_deref(), meta);
            self.client
                .publish(subject, bytes)
                .await
                .map_err(|_| Unavailable)?;
            // A broker cannot count who heard it.
            Ok(IngestReceipt { observers: None })
        }
        .boxed()
    }

    fn ingest_request(
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
            let (subject, bytes) = message(&channel, payload, scope.as_deref(), meta);
            // The broker answers a publish nobody subscribes to with a
            // no-responders status on its reply subject. It handles this
            // connection's writes in order, so once `flush` returns (on its own
            // no-responders, sent after this one) the status is in the inbox if
            // it was sent at all. Nothing that receives a frame reads its reply
            // subject. Every subscription on a request subject is some
            // replica's client stream, so a zero here is a zero across replicas.
            let inbox = self.client.new_inbox();
            let mut replies = self
                .client
                .subscribe(inbox.clone())
                .await
                .map_err(|_| Unavailable)?;
            self.client
                .publish_with_reply(subject, inbox, bytes)
                .await
                .map_err(|_| Unavailable)?;
            // Published either way; a flush that fails leaves the zero unlearned.
            let learned = self.flush().await.is_ok();
            let nobody = learned
                && replies
                    .next()
                    .now_or_never()
                    .flatten()
                    .is_some_and(|reply| reply.status == Some(StatusCode::NO_RESPONDERS));
            Ok(IngestReceipt {
                observers: nobody.then_some(0),
            })
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
            // The broker reads this connection's writes in order: once it has
            // answered the flush, it holds every subscription above.
            self.flush().await?;
            let on_frame = subscription.on_frame;
            let pump = tokio::spawn(async move {
                let mut merged = futures::stream::select_all(streams);
                while let Some((scope, channel, message)) = merged.next().await {
                    if let Some(wire) = decode(&message.payload) {
                        on_frame(Frame {
                            publish_id: wire.id,
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
        async move {
            nats::flush(&self.client, format!("{PREFIX}flush"))
                .await
                .map_err(|e| e.to_string())
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

    fn put(&self, key: String, value: String) -> BoxFuture<'_, Result<(), String>> {
        async move {
            self.store
                .put(b64url(&key), Bytes::from(value))
                .await
                .map(|_| ())
                .map_err(|e| logging::chain(&e))
        }
        .boxed()
    }

    fn delete(&self, key: String) -> BoxFuture<'_, Result<(), String>> {
        async move {
            self.store
                .delete(b64url(&key))
                .await
                .map_err(|e| logging::chain(&e))
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

    fn watch(&self, on_entry: TableWatcher) -> BoxFuture<'_, Result<Subscription, String>> {
        async move {
            let pump = nats::read_then_watch(
                &self.store,
                Arc::new(move |key, value| {
                    if let Some(key) = from_b64url(&key) {
                        on_entry(
                            key,
                            value.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()),
                        );
                    }
                }),
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(Subscription::new(move || pump.abort()))
        }
        .boxed()
    }
}
