//! The correlation ledger: who owns the reply to each request, and whether a
//! correlated frame may reach a subscriber. Gateway policy, above the plane:
//! the one module that reads the correlation id out of a frame's metadata.
//!
//! Claims live in a table every replica shares (`ledger_claims`). Each
//! replica holds a projection of it, fed by the table's watch, and decides
//! frames against that projection:
//!
//!  - `claim` writes the table before the request is published, atomically
//!    across replicas, so an id claimed anywhere is a conflict here; once it
//!    returns, a read of the table finds the claim.
//!  - The projection can lag behind a reply. A frame whose id this replica
//!    does not hold is not refused on that evidence: the replica reads the
//!    table — once per id, however many subscribers missed — and decides
//!    again, holding that id's later frames behind the read.
//!  - Nothing reports a claim's expiry, so the projection keeps its own clock:
//!    a claim's age is the one its origin stored.
//!  - Whether a claim was answered is shared too (`ledger_answered`), so a
//!    replica that loads a claim after its reply went by does not count it
//!    against its client's cap, or report it lost when it expires.
//!
//! Retention keeps the first reply to each claimed id in a third table
//! (`ledger_replies`) for `replyRetentionSeconds`; recovery answers from any
//! replica, and only to the claim's owner.

use crate::signal::{Meta, SharedTable, SignalPlane, Subscription};
use crate::{limits, metrics};
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use semiont_observability::logging;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CLAIMS: &str = "ledger_claims";
const REPLIES: &str = "ledger_replies";
const ANSWERED: &str = "ledger_answered";

/// Claims one replica's projection holds at once; past this the oldest is
/// evicted. Correct clients cannot reach it: each is capped far below.
const CLAIM_MAX_GLOBAL: usize = 4096;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn bus(fields: Value) -> Value {
    let mut fields = fields;
    fields["component"] = json!("bus");
    fields
}

/// A map that remembers insertion order, with removal by key.
struct Ordered<V> {
    next: u64,
    order: BTreeMap<u64, String>,
    entries: HashMap<String, (u64, V)>,
}

impl<V> Ordered<V> {
    fn new() -> Ordered<V> {
        Ordered {
            next: 0,
            order: BTreeMap::new(),
            entries: HashMap::new(),
        }
    }
    fn insert(&mut self, key: String, value: V) {
        self.remove(&key);
        self.order.insert(self.next, key.clone());
        self.entries.insert(key, (self.next, value));
        self.next += 1;
    }
    fn remove(&mut self, key: &str) -> Option<V> {
        let (at, value) = self.entries.remove(key)?;
        self.order.remove(&at);
        Some(value)
    }
    fn get(&self, key: &str) -> Option<&V> {
        self.entries.get(key).map(|(_, v)| v)
    }
    fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.entries.get_mut(key).map(|(_, v)| v)
    }
    fn contains(&self, key: &str) -> bool {
        self.entries.contains_key(key)
    }
    fn values(&self) -> impl Iterator<Item = &V> {
        self.entries.values().map(|(_, v)| v)
    }
    fn first(&self) -> Option<(String, &V)> {
        let key = self.order.values().next()?;
        Some((key.clone(), self.get(key)?))
    }
    fn len(&self) -> usize {
        self.entries.len()
    }
}

struct Claim {
    client_id: String,
    principal_did: Option<String>,
    claimed_at: u64,
    /// A reply has been seen: the claim stops counting against its client's cap.
    answered: bool,
}

/// A claim as the shared table holds it.
#[derive(Serialize, Deserialize)]
struct StoredClaim {
    #[serde(rename = "clientId")]
    client_id: String,
    #[serde(rename = "principalDid", skip_serializing_if = "Option::is_none")]
    principal_did: Option<String>,
    #[serde(rename = "claimedAt")]
    claimed_at: f64,
}

/// A retained reply as the shared table holds it; its id is the key.
#[derive(Serialize, Deserialize)]
struct StoredReply {
    channel: String,
    payload: Value,
    #[serde(rename = "retainedAt")]
    retained_at: f64,
}

pub struct RetainedReply {
    pub channel: String,
    pub payload: Value,
    pub correlation_id: String,
}

pub enum ClaimOutcome {
    Ok,
    Conflict,
    /// The client awaits as many replies as it may; `retry_after` is when its
    /// oldest unanswered claim expires, the latest a slot frees.
    AtCapacity {
        retry_after: Duration,
    },
}

#[derive(PartialEq)]
enum Verdict {
    Deliver,
    Drop,
    Unknown,
}

struct State {
    claims: Ordered<Claim>,
    /// Unanswered claims per client: what the 429 counts.
    per_client: HashMap<String, usize>,
    /// Answered markers that arrived before their claim did: the two tables
    /// are watched separately.
    answered_ahead: Ordered<u64>,
}

type Read = Shared<BoxFuture<'static, ()>>;

pub struct Ledger {
    state: Mutex<State>,
    claims: Arc<dyn SharedTable>,
    answered: Arc<dyn SharedTable>,
    replies: Arc<dyn SharedTable>,
    watches: Mutex<Vec<Subscription>>,
    reads: Mutex<HashMap<String, Read>>,
    claim_ms: u64,
    retention_ms: u64,
    pending_replies_max: usize,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

impl Ledger {
    /// Open the three tables and project the claims and answers they already
    /// hold. Resolves once this replica's projection holds every claim the
    /// table contained.
    pub async fn open(plane: &dyn SignalPlane) -> Result<Arc<Ledger>, String> {
        let limits = limits::limits();
        let claim_ms = limits.claim_seconds * 1000;
        let retention_ms = limits.reply_retention_seconds * 1000;
        let claims = plane
            .table(CLAIMS.to_owned(), Duration::from_millis(claim_ms))
            .await?;
        let answered = plane
            .table(ANSWERED.to_owned(), Duration::from_millis(claim_ms))
            .await?;
        let replies = plane
            .table(REPLIES.to_owned(), Duration::from_millis(retention_ms))
            .await?;
        let ledger = Arc::new(Ledger {
            state: Mutex::new(State {
                claims: Ordered::new(),
                per_client: HashMap::new(),
                answered_ahead: Ordered::new(),
            }),
            claims: claims.clone(),
            answered: answered.clone(),
            replies,
            watches: Mutex::new(Vec::new()),
            reads: Mutex::new(HashMap::new()),
            claim_ms,
            retention_ms,
            pending_replies_max: limits.pending_replies_max,
        });
        let weak: Weak<Ledger> = Arc::downgrade(&ledger);
        let adopt = weak.clone();
        let claims_watch = claims
            .watch(Arc::new(move |cid, value| {
                if let (Some(ledger), Some(value)) = (adopt.upgrade(), value) {
                    ledger.adopt(&cid, &value);
                }
            }))
            .await?;
        let mark = weak;
        let answered_watch = answered
            .watch(Arc::new(move |cid, value| {
                if let (Some(ledger), Some(_)) = (mark.upgrade(), value) {
                    ledger.mark_answered(&cid);
                }
            }))
            .await?;
        locked(&ledger.watches).extend([claims_watch, answered_watch]);
        Ok(ledger)
    }

    fn release(state: &mut State, client_id: &str) {
        let remaining = state
            .per_client
            .get(client_id)
            .copied()
            .unwrap_or(1)
            .saturating_sub(1);
        if remaining == 0 {
            state.per_client.remove(client_id);
        } else {
            state.per_client.insert(client_id.to_owned(), remaining);
        }
    }

    fn forget(state: &mut State, cid: &str) {
        if let Some(claim) = state.claims.remove(cid)
            && !claim.answered
        {
            Self::release(state, &claim.client_id);
        }
    }

    /// Sweep expired claims. One never answered is where a lossy mode begins
    /// — its reply can no longer be delivered — so it is logged.
    fn sweep(&self, state: &mut State) {
        let now = now_ms();
        let cutoff = now.saturating_sub(self.claim_ms);
        while let Some((cid, claim)) = state.claims.first() {
            if claim.claimed_at > cutoff {
                break;
            }
            if !claim.answered {
                logging::warn(
                    "[bus CLAIM-EXPIRED] claim swept with no reply",
                    bus(
                        json!({ "correlationId": cid, "clientId": claim.client_id, "ageMs": now.saturating_sub(claim.claimed_at) }),
                    ),
                );
            }
            Self::forget(state, &cid);
        }
    }

    fn evict_at_cap(state: &mut State) {
        if state.claims.len() < CLAIM_MAX_GLOBAL {
            return;
        }
        if let Some((oldest, _)) = state.claims.first() {
            logging::warn(
                "[bus CLAIM-EVICTED] global claim cap reached",
                bus(json!({ "correlationId": oldest, "cap": CLAIM_MAX_GLOBAL })),
            );
            Self::forget(state, &oldest);
        }
    }

    fn record(state: &mut State, cid: &str, stored: &StoredClaim) {
        Self::evict_at_cap(state);
        let answered = state.answered_ahead.remove(cid).is_some();
        state.claims.insert(
            cid.to_owned(),
            Claim {
                client_id: stored.client_id.clone(),
                principal_did: stored.principal_did.clone(),
                claimed_at: stored.claimed_at as u64,
                answered,
            },
        );
        if !answered {
            *state
                .per_client
                .entry(stored.client_id.clone())
                .or_insert(0) += 1;
        }
    }

    /// The one place a claim becomes answered: its client's slot is released once.
    fn mark_answered(&self, cid: &str) {
        let mut state = locked(&self.state);
        let Some(claim) = state.claims.get_mut(cid) else {
            let cutoff = now_ms().saturating_sub(self.claim_ms);
            while let Some((ahead, at)) = state.answered_ahead.first() {
                if *at > cutoff {
                    break;
                }
                state.answered_ahead.remove(&ahead);
            }
            state.answered_ahead.insert(cid.to_owned(), now_ms());
            return;
        };
        if claim.answered {
            return;
        }
        claim.answered = true;
        let client = claim.client_id.clone();
        Self::release(&mut state, &client);
    }

    /// A claim learned from the table. Never refused: it was accepted where it
    /// was made, and refusing it here would fork the replicas' projections.
    fn adopt(&self, cid: &str, value: &str) {
        let mut state = locked(&self.state);
        if state.claims.contains(cid) {
            return;
        }
        let Some(stored) = parse_claim(value) else {
            logging::warn(
                "[bus CLAIM-MALFORMED] unparseable stored claim ignored",
                bus(json!({ "correlationId": cid })),
            );
            return;
        };
        if now_ms().saturating_sub(stored.claimed_at as u64) > self.claim_ms {
            return;
        }
        Self::record(&mut state, cid, &stored);
    }

    /// Emit-as-claim: resolves once the claim is in the shared table, and the
    /// request may be published.
    pub async fn claim(
        &self,
        cid: &str,
        client_id: &str,
        principal_did: Option<&str>,
    ) -> Result<ClaimOutcome, String> {
        let stored = {
            let mut state = locked(&self.state);
            self.sweep(&mut state);
            if state.claims.contains(cid) {
                return Ok(ClaimOutcome::Conflict);
            }
            if state.per_client.get(client_id).copied().unwrap_or(0) >= self.pending_replies_max {
                let now = now_ms();
                let expires = state
                    .claims
                    .values()
                    .filter(|c| c.client_id == client_id && !c.answered)
                    .map(|c| c.claimed_at + self.claim_ms)
                    .min()
                    .unwrap_or(now);
                return Ok(ClaimOutcome::AtCapacity {
                    retry_after: Duration::from_millis(expires.saturating_sub(now)),
                });
            }
            StoredClaim {
                client_id: client_id.to_owned(),
                principal_did: principal_did.map(str::to_owned),
                claimed_at: now_ms() as f64,
            }
        };
        let value = serde_json::to_string(&stored).expect("a claim serializes");
        if !self.claims.create(cid.to_owned(), value).await? {
            return Ok(ClaimOutcome::Conflict);
        }
        let mut state = locked(&self.state);
        // The watch may already have delivered it; it counts once either way.
        if !state.claims.contains(cid) {
            Self::record(&mut state, cid, &stored);
        }
        Ok(ClaimOutcome::Ok)
    }

    /// One correlated frame, as the composition's standing tap saw it.
    pub fn observe(self: &Arc<Self>, channel: &str, payload: &Value, meta: Option<&Meta>) {
        let Some(cid) = meta.and_then(|m| m.get("correlationId")).cloned() else {
            return;
        };
        if !locked(&self.state).claims.contains(&cid) {
            return;
        }
        self.mark_answered(&cid);
        self.sweep(&mut locked(&self.state));
        // First writer wins, for both tables: every replica holding the claim
        // offers the same facts, and a refusal means another got there first.
        let answered = self.answered.clone();
        let marked = cid.clone();
        tokio::spawn(async move {
            if let Err(error) = answered.create(marked.clone(), now_ms().to_string()).await {
                logging::warn(
                    "[bus ANSWERED-RECORD-FAILED] claim could not be recorded as answered",
                    bus(json!({ "correlationId": marked, "error": error })),
                );
            }
        });
        let stored = serde_json::to_string(&StoredReply {
            channel: channel.to_owned(),
            payload: payload.clone(),
            retained_at: now_ms() as f64,
        })
        .expect("a reply serializes");
        let replies = self.replies.clone();
        tokio::spawn(async move {
            if let Err(error) = replies.create(cid.clone(), stored).await {
                logging::warn(
                    "[bus REPLY-RETAIN-FAILED] reply could not be retained for recovery",
                    bus(json!({ "correlationId": cid, "error": error })),
                );
            }
        });
    }

    fn decide(
        &self,
        channel: &str,
        cid: &str,
        client_id: &str,
        principal_did: Option<&str>,
    ) -> Verdict {
        let state = locked(&self.state);
        let Some(claim) = state.claims.get(cid) else {
            return Verdict::Unknown;
        };
        if now_ms().saturating_sub(claim.claimed_at) > self.claim_ms {
            return Verdict::Drop;
        }
        if claim.client_id == client_id && claim.principal_did.as_deref() == principal_did {
            return Verdict::Deliver;
        }
        // Owned by someone else: the amplification the filter removes.
        metrics::record_reply_suppressed(channel);
        Verdict::Drop
    }

    /// One read of the claims table per id per replica, however many
    /// subscribers missed it. A reply whose claim is nowhere is delivered to
    /// no one, and said so once.
    fn read_through(self: &Arc<Self>, cid: &str, reply_channel: Option<&str>) -> Read {
        let mut reads = locked(&self.reads);
        if let Some(pending) = reads.get(cid) {
            return pending.clone();
        }
        let ledger = self.clone();
        let (cid_owned, channel) = (cid.to_owned(), reply_channel.map(str::to_owned));
        let read: Read = async move {
            match ledger.claims.read(cid_owned.clone()).await {
                Ok(Some(value)) => ledger.adopt(&cid_owned, &value),
                Ok(None) => {
                    if let Some(channel) = channel {
                        logging::warn(
                            "[bus REPLY-UNCLAIMED] a reply for a correlationId no client holds a claim on; delivered to no one",
                            bus(json!({ "correlationId": cid_owned, "channel": channel })),
                        );
                    }
                }
                Err(error) => logging::warn(
                    "[bus CLAIM-READ-FAILED] claim could not be read; held frames dropped",
                    bus(json!({ "correlationId": cid_owned, "error": error })),
                ),
            }
            locked(&ledger.reads).remove(&cid_owned);
        }
        .boxed()
        .shared();
        reads.insert(cid.to_owned(), read.clone());
        read
    }

    /// The entitlement decision for one subscriber.
    pub fn gate(
        self: &Arc<Self>,
        client_id: &str,
        principal_did: Option<&str>,
    ) -> Arc<DeliveryGate> {
        Arc::new(DeliveryGate {
            ledger: self.clone(),
            client_id: client_id.to_owned(),
            principal_did: principal_did.map(str::to_owned),
            held: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        })
    }

    /// The retained reply to `cid`, for its owner only: ownership is read
    /// from the projection, or through to the claims table.
    pub async fn lookup_reply(
        self: &Arc<Self>,
        cid: &str,
        client_id: &str,
        principal_did: Option<&str>,
    ) -> Option<RetainedReply> {
        if !locked(&self.state).claims.contains(cid) {
            self.read_through(cid, None).await;
        }
        {
            let state = locked(&self.state);
            let claim = state.claims.get(cid)?;
            if claim.client_id != client_id || claim.principal_did.as_deref() != principal_did {
                return None;
            }
        }
        let value = self.replies.read(cid.to_owned()).await.ok()??;
        let Ok(reply) = serde_json::from_str::<StoredReply>(&value) else {
            logging::warn(
                "[bus REPLY-MALFORMED] unparseable retained reply ignored",
                bus(json!({ "correlationId": cid })),
            );
            return None;
        };
        // The broker expires the table on its own schedule; the window a
        // caller is promised is kept here.
        if now_ms().saturating_sub(reply.retained_at as u64) > self.retention_ms {
            return None;
        }
        Some(RetainedReply {
            channel: reply.channel,
            payload: reply.payload,
            correlation_id: cid.to_owned(),
        })
    }

    /// Live claims this replica holds, and the cap they are measured against.
    pub fn occupancy(&self) -> (u64, u64) {
        (
            locked(&self.state).claims.len() as u64,
            CLAIM_MAX_GLOBAL as u64,
        )
    }
}

fn parse_claim(value: &str) -> Option<StoredClaim> {
    let stored: StoredClaim = serde_json::from_str(value).ok()?;
    (!stored.client_id.is_empty() && stored.claimed_at.is_finite()).then_some(stored)
}

type Deliver = Box<dyn FnOnce() + Send>;

/// One subscriber's entitlement to correlated frames.
pub struct DeliveryGate {
    ledger: Arc<Ledger>,
    client_id: String,
    principal_did: Option<String>,
    /// Decisions waiting on an id's table read, in arrival order.
    held: Mutex<HashMap<String, Vec<Deliver>>>,
    closed: AtomicBool,
}

impl DeliveryGate {
    fn deliver_if_owned(
        self: &Arc<Self>,
        channel: String,
        cid: String,
        deliver: Deliver,
    ) -> Deliver {
        let gate = self.clone();
        Box::new(move || {
            if !gate.closed.load(Ordering::SeqCst)
                && gate.ledger.decide(
                    &channel,
                    &cid,
                    &gate.client_id,
                    gate.principal_did.as_deref(),
                ) == Verdict::Deliver
            {
                deliver();
            }
        })
    }

    /// An unscoped frame on a correlated channel: `deliver` runs if this
    /// subscriber owns the frame's claim — now, when the claim is known here,
    /// or after the table read, when it is not.
    pub fn offer(self: &Arc<Self>, channel: &str, cid: Option<&str>, deliver: Deliver) {
        let Some(cid) = cid else {
            logging::warn(
                "[bus REPLY-NO-CID] correlated frame without a correlationId",
                bus(json!({ "channel": channel })),
            );
            return;
        };
        let mut held = locked(&self.held);
        if let Some(waiting) = held.get_mut(cid) {
            waiting.push(self.deliver_if_owned(channel.to_owned(), cid.to_owned(), deliver));
            return;
        }
        match self
            .ledger
            .decide(channel, cid, &self.client_id, self.principal_did.as_deref())
        {
            Verdict::Deliver => {
                drop(held);
                deliver();
            }
            Verdict::Drop => {}
            Verdict::Unknown => {
                held.insert(
                    cid.to_owned(),
                    vec![self.deliver_if_owned(channel.to_owned(), cid.to_owned(), deliver)],
                );
                let read = self.ledger.read_through(cid, Some(channel));
                let (gate, cid) = (self.clone(), cid.to_owned());
                tokio::spawn(async move {
                    read.await;
                    let queue = locked(&gate.held).remove(&cid).unwrap_or_default();
                    for run in queue {
                        run();
                    }
                });
            }
        }
    }

    /// The subscriber is gone: nothing held for it is delivered.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        locked(&self.held).clear();
    }
}
