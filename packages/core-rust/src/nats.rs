//! Reaching the messaging broker, as every service that holds a connection to
//! it does: connecting with no limit on reconnects, saying in the log when the
//! broker goes and comes back, a readiness flush, and reading a key-value
//! bucket whole under a watch that has already started. Behind the `nats`
//! feature: a crate that does not enable it cannot reach the broker.

use async_nats::jetstream::kv;
use bytes::Bytes;
use futures::StreamExt;
use semiont_observability::logging;
use serde_json::json;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// What a service's broker log lines say: its tag (`[<tag> BROKER-DOWN]`),
/// what stops while the broker is away, and who the broker refused.
pub struct Voice {
    pub tag: &'static str,
    pub while_down: &'static str,
    pub refused: &'static str,
}

/// Why the broker could not be used.
#[derive(Debug)]
pub enum BrokerError {
    /// The first connection failed.
    Connect(String),
    /// A round trip through the broker failed.
    Flush(String),
    /// A bucket could not be read or watched.
    Watch(String),
}

impl fmt::Display for BrokerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BrokerError::Connect(message)
            | BrokerError::Flush(message)
            | BrokerError::Watch(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for BrokerError {}

/// Connect, retrying for as long as the broker is unreachable once
/// connected; the first connection must succeed.
pub async fn connect(
    servers: &str,
    user: Option<String>,
    password: Option<String>,
    voice: Voice,
) -> Result<async_nats::Client, BrokerError> {
    let reconnecting = Arc::new(AtomicBool::new(false));
    let watched = servers.to_owned();
    let Voice {
        tag,
        while_down,
        refused,
    } = voice;
    let mut options = async_nats::ConnectOptions::new()
        .max_reconnects(None)
        .event_callback(move |event| {
            let servers = watched.clone();
            let reconnecting = reconnecting.clone();
            async move {
                match event {
                    async_nats::Event::Disconnected => {
                        reconnecting.store(true, Ordering::SeqCst);
                        logging::warn(
                            &format!("[{tag} BROKER-DOWN] NATS connection lost; {while_down}"),
                            json!({ "component": tag, "servers": servers }),
                        );
                    }
                    async_nats::Event::Connected if reconnecting.swap(false, Ordering::SeqCst) => {
                        logging::info(
                            &format!("[{tag} BROKER-RECONNECTED] NATS connection restored"),
                            json!({ "component": tag, "servers": servers }),
                        );
                    }
                    async_nats::Event::ServerError(error) => {
                        logging::error(
                            &format!("[{tag} BROKER-REFUSED] the broker refused {refused}"),
                            json!({ "component": tag, "servers": servers, "reason": error.to_string() }),
                        );
                    }
                    _ => {}
                }
            }
        });
    if user.is_some() || password.is_some() {
        options = options.user_and_password(user.unwrap_or_default(), password.unwrap_or_default());
    }
    options.connect(servers).await.map_err(|e| {
        BrokerError::Connect(format!(
            "cannot connect to the NATS broker at {servers}: {e}"
        ))
    })
}

/// One round trip through the broker: a request nobody answers comes back
/// "no responders" once the broker has read everything this connection wrote
/// before it — subscriptions included.
pub async fn flush(client: &async_nats::Client, subject: String) -> Result<(), BrokerError> {
    match client.request(subject, Bytes::new()).await {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == async_nats::RequestErrorKind::NoResponders => Ok(()),
        Err(error) => Err(BrokerError::Flush(error.to_string())),
    }
}

/// Every entry of `store`, now and from now on, to `on_entry` (`None`: the key
/// was deleted). Everything after the bucket's last sequence arrives on the
/// watch; everything up to it is read key by key. An entry both see is
/// delivered twice, which a watcher takes as once. Answers the watch's task.
pub async fn read_then_watch(
    store: &kv::Store,
    on_entry: Arc<dyn Fn(String, Option<Bytes>) + Send + Sync>,
) -> Result<tokio::task::JoinHandle<()>, BrokerError> {
    let failed = |e: &dyn std::error::Error| BrokerError::Watch(logging::chain(e));
    let last = store
        .stream
        .get_info()
        .await
        .map_err(|e| failed(&e))?
        .state
        .last_sequence;
    let mut entries = store
        .watch_all_from_revision(last + 1)
        .await
        .map_err(|e| failed(&e))?;
    let live = on_entry.clone();
    let pump = tokio::spawn(async move {
        while let Some(Ok(entry)) = entries.next().await {
            match entry.operation {
                kv::Operation::Put => live(entry.key, Some(entry.value)),
                kv::Operation::Delete | kv::Operation::Purge => live(entry.key, None),
            }
        }
    });
    let read = async {
        let mut keys = store.keys().await.map_err(|e| failed(&e))?;
        while let Some(key) = keys.next().await {
            let key = key.map_err(|e| failed(&e))?;
            if let Some(value) = store.get(key.clone()).await.map_err(|e| failed(&e))? {
                on_entry(key, Some(value));
            }
        }
        Ok::<(), BrokerError>(())
    };
    match read.await {
        Ok(()) => Ok(pump),
        Err(error) => {
            pump.abort();
            Err(error)
        }
    }
}
