//! Streams per principal, counted across replicas
//! (`x-semiont-limits.streamsPerPrincipal`). Each stream a limited principal
//! holds is an entry in a table every replica shares, keyed by the stream's id
//! and naming its DID: its lease. The connection writes it again every
//! heartbeat and deletes it when the stream ends. A lease whose connection
//! stopped writing — its replica died — lapses two heartbeats after its last
//! write: the table expires it, and each replica's projection keeps the same
//! clock, since an expiry is not reported. A replica counts against its
//! projection, so near the limit two replicas can each admit one more.
//! Whether the DID names a person or an agent makes no difference; a principal
//! whose roles make it unlimited takes no lease.

use crate::limits;
use crate::principal::Principal;
use crate::signal::{SharedTable, SignalPlane, Subscription};
use semiont_core::logging;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

const TABLE: &str = "streams_held";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

pub struct StreamCounts {
    table: Arc<dyn SharedTable>,
    lease_ms: u64,
    /// Stream id → the DID holding it, and when its lease was last written.
    held: Mutex<HashMap<String, (String, u64)>>,
    watch: Mutex<Option<Subscription>>,
}

impl StreamCounts {
    /// Open the table and project the leases it already holds.
    pub async fn open(plane: &dyn SignalPlane) -> Result<Arc<StreamCounts>, String> {
        let lease = Duration::from_secs(2 * limits::limits().heartbeat_seconds);
        let table = plane.table(TABLE.to_owned(), lease).await?;
        let counts = Arc::new(StreamCounts {
            table: table.clone(),
            lease_ms: lease.as_millis() as u64,
            held: Mutex::new(HashMap::new()),
            watch: Mutex::new(None),
        });
        let observer = Arc::downgrade(&counts);
        let watch = table
            .watch(Arc::new(move |id, value| {
                if let Some(counts) = observer.upgrade() {
                    counts.observe(id, value);
                }
            }))
            .await?;
        *locked(&counts.watch) = Some(watch);
        Ok(counts)
    }

    fn observe(&self, id: String, value: Option<String>) {
        let mut held = locked(&self.held);
        match value.as_deref().and_then(parse) {
            Some(lease) => held.insert(id, lease),
            None => held.remove(&id),
        };
    }

    /// Admit a stream for `principal`: its lease (none, when its roles make it
    /// unlimited), or how long to wait before asking again.
    pub fn admit(self: &Arc<Self>, principal: &Principal) -> Result<Option<StreamLease>, Duration> {
        let roles = principal.roles.as_deref().unwrap_or_default();
        let Some(limit) = limits::limits().streams_per_principal.for_roles(roles) else {
            return Ok(None);
        };
        let now = now_ms();
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut held = locked(&self.held);
            held.retain(|_, (_, at)| now.saturating_sub(*at) < self.lease_ms);
            let holding = held
                .values()
                .filter(|(did, _)| *did == principal.did)
                .count();
            if holding as u64 >= limit {
                return Err(Duration::from_secs(limits::limits().heartbeat_seconds));
            }
            held.insert(id.clone(), (principal.did.clone(), now));
        }
        Ok(Some(StreamLease::take(
            self.clone(),
            id,
            principal.did.clone(),
            now,
        )))
    }
}

fn parse(value: &str) -> Option<(String, u64)> {
    let lease: Value = serde_json::from_str(value).ok()?;
    Some((lease["did"].as_str()?.to_owned(), lease["at"].as_u64()?))
}

enum Write {
    Renew(u64),
    Release,
}

/// One stream's place in the count, held while the stream is open. Its writes
/// to the table go through one task, in order: a stream that ends at once
/// cannot have its delete overtake its first write.
pub struct StreamLease {
    counts: Arc<StreamCounts>,
    id: String,
    did: String,
    writes: mpsc::UnboundedSender<Write>,
}

impl StreamLease {
    fn take(counts: Arc<StreamCounts>, id: String, did: String, at: u64) -> StreamLease {
        let (writes, mut pending) = mpsc::unbounded_channel();
        let table = counts.table.clone();
        let (key, holder) = (id.clone(), did.clone());
        tokio::spawn(async move {
            while let Some(write) = pending.recv().await {
                let outcome = match write {
                    Write::Renew(at) => {
                        let value = json!({ "did": holder, "at": at }).to_string();
                        table.put(key.clone(), value).await
                    }
                    Write::Release => {
                        let outcome = table.delete(key.clone()).await;
                        pending.close();
                        outcome
                    }
                };
                if let Err(error) = outcome {
                    logging::warn(
                        "[streams LEASE-UNWRITTEN] the table did not take a stream's lease",
                        json!({ "component": "streams", "streamId": key, "error": error }),
                    );
                }
            }
        });
        let _ = writes.send(Write::Renew(at));
        StreamLease {
            counts,
            id,
            did,
            writes,
        }
    }

    /// Write the lease again: its two heartbeats start over.
    pub fn renew(&self) {
        let now = now_ms();
        locked(&self.counts.held).insert(self.id.clone(), (self.did.clone(), now));
        let _ = self.writes.send(Write::Renew(now));
    }
}

impl Drop for StreamLease {
    fn drop(&mut self) {
        locked(&self.counts.held).remove(&self.id);
        let _ = self.writes.send(Write::Release);
    }
}
