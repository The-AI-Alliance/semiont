//! The keys of emits (`POST /bus/emit`'s `Idempotency-Key`), in a table every
//! replica shares. Once an emit's outcome is one another attempt would get
//! again, the outcome is held under its key for `idempotencySeconds`: a repeat
//! with the same body is answered as the first was, and one with another body
//! is refused 422. A repeat that arrives while the first is in hand waits for
//! it, and takes it over once its lease, `emitTimeoutMs`, has run out.
//!
//! Once an attempt holds its key, the emit and the key's settling run to their
//! end as a task of their own, even when the client goes away: a resend is
//! answered by what the emit did, never carried out a second time because the
//! first was cut short. The outcome is held only over the attempt's own
//! `InHand` entry, so an attempt that outran its lease cannot overwrite the
//! entry of the one that took it over.
//!
//! A key is its principal's: the table is keyed by a hash of the two, so
//! another principal's key of the same text is another entry, and no client
//! text is ever a table key.

use crate::http::{ApiError, json_response};
use crate::limits;
use crate::signal::{SharedTable, SignalPlane, now_ms};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use semiont::timing::EMIT_TIMEOUT;
use semiont::types::BusEmitAccepted;
use semiont_observability::logging;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

const TABLE: &str = "emit_keys";

/// How often a repeat reads the entry of the attempt it waits for.
const WAIT_POLL: Duration = Duration::from_millis(100);

/// An entry as the table holds it.
#[derive(Serialize, Deserialize)]
#[serde(tag = "state")]
enum Entry {
    /// An attempt is carrying the emit out, and may until `lease_until` (ms since the epoch).
    #[serde(rename = "inHand")]
    InHand {
        digest: String,
        #[serde(rename = "leaseUntil")]
        lease_until: u64,
    },
    /// The emit's outcome, which every repeat is answered with.
    #[serde(rename = "done")]
    Done {
        digest: String,
        status: u16,
        body: Value,
    },
}

impl Entry {
    fn digest(&self) -> &str {
        match self {
            Entry::InHand { digest, .. } | Entry::Done { digest, .. } => digest,
        }
    }
}

pub struct EmitKeys {
    table: Arc<dyn SharedTable>,
    lease: Duration,
}

/// What a request finds under its key.
enum Taken {
    /// Nothing another attempt holds: this one carries the emit out.
    Ours(Held),
    /// The answer an earlier attempt settled on.
    Answered(Response),
}

impl EmitKeys {
    pub async fn open(plane: &dyn SignalPlane) -> Result<EmitKeys, String> {
        Self::lasting(
            plane,
            Duration::from_secs(limits::limits().idempotency_seconds),
        )
        .await
    }

    async fn lasting(plane: &dyn SignalPlane, lifetime: Duration) -> Result<EmitKeys, String> {
        Ok(EmitKeys {
            table: plane.table(TABLE.to_owned(), lifetime).await?,
            lease: EMIT_TIMEOUT,
        })
    }

    /// The answer to `principal`'s emit of `request` under `key`: the held
    /// outcome of an earlier attempt, or `carry_out`'s, which holds the key or
    /// clears it. Once the key is this attempt's, `carry_out` and the settling
    /// of the key run as a task of their own, which the client going away
    /// does not cut short. A task that panics answers 500, and its key is let
    /// go as the task unwinds.
    pub async fn answer<F>(
        &self,
        principal: &str,
        key: &str,
        request: Value,
        carry_out: impl FnOnce(Value) -> F,
    ) -> Response
    where
        F: Future<Output = Result<BusEmitAccepted, ApiError>> + Send + 'static,
    {
        let id = table_key(principal, key);
        let digest = digest(&request);
        let held = match self.take(&id, &digest).await {
            Ok(Taken::Ours(held)) => held,
            Ok(Taken::Answered(answer)) => return answer,
            Err(refusal) => return refusal.into_response(),
        };
        let emit = carry_out(request);
        let settled = tokio::spawn(async move {
            let outcome = emit.await;
            let (status, body) = match &outcome {
                Ok(accepted) => (
                    StatusCode::ACCEPTED,
                    serde_json::to_value(accepted).expect("a BusEmitAccepted serializes"),
                ),
                Err(refusal) => (refusal.status(), refusal.body().clone()),
            };
            held.settle(&digest, status, body).await;
            outcome
        });
        match settled.await {
            Ok(Ok(accepted)) => json_response(StatusCode::ACCEPTED, &accepted),
            Ok(Err(refusal)) => refusal.into_response(),
            Err(panicked) => ApiError::internal("carrying out an emit", panicked).into_response(),
        }
    }

    fn in_hand(&self, digest: &str) -> String {
        serde_json::to_string(&Entry::InHand {
            digest: digest.to_owned(),
            lease_until: now_ms() + self.lease.as_millis() as u64,
        })
        .expect("an entry serializes")
    }

    /// The key is this attempt's, under the `InHand` entry it wrote.
    fn held(&self, id: &str, in_hand: String) -> Taken {
        Taken::Ours(Held {
            table: self.table.clone(),
            id: id.to_owned(),
            in_hand,
            settled: false,
        })
    }

    async fn take(&self, id: &str, digest: &str) -> Result<Taken, ApiError> {
        loop {
            let in_hand = self.in_hand(digest);
            let created = self
                .table
                .create(id.to_owned(), in_hand.clone())
                .await
                .map_err(|e| ApiError::unrecorded("recording an emit's key", e))?;
            if created {
                return Ok(self.held(id, in_hand));
            }
            if let Some(taken) = self.wait(id, digest).await? {
                return Ok(taken);
            }
        }
    }

    /// The entry another attempt made: answered from once it is done, waited
    /// for while it is in hand, and taken over once its lease has run out.
    /// `None` when it is deleted, and the key is free again.
    async fn wait(&self, id: &str, digest: &str) -> Result<Option<Taken>, ApiError> {
        loop {
            let read = self
                .table
                .read(id.to_owned())
                .await
                .map_err(|e| ApiError::unrecorded("reading an emit's key", e))?;
            let Some(stored) = read else {
                return Ok(None);
            };
            let entry: Entry = serde_json::from_str(&stored)
                .map_err(|e| ApiError::internal("reading an emit's key", e))?;
            if entry.digest() != digest {
                return Err(ApiError::unprocessable(
                    "This Idempotency-Key was first sent with another body",
                ));
            }
            match entry {
                Entry::Done { status, body, .. } => {
                    let status = StatusCode::from_u16(status)
                        .map_err(|e| ApiError::internal("reading an emit's key", e))?;
                    return Ok(Some(Taken::Answered(json_response(status, &body))));
                }
                Entry::InHand { lease_until, .. } => {
                    let now = now_ms();
                    if now < lease_until {
                        tokio::time::sleep(WAIT_POLL.min(Duration::from_millis(lease_until - now)))
                            .await;
                        continue;
                    }
                    let in_hand = self.in_hand(digest);
                    let taken_over = self
                        .table
                        .replace(id.to_owned(), stored, in_hand.clone())
                        .await
                        .map_err(|e| ApiError::unrecorded("taking over an emit's key", e))?;
                    if taken_over {
                        return Ok(Some(self.held(id, in_hand)));
                    }
                }
            }
        }
    }
}

/// An entry this attempt holds in hand, until its outcome settles it.
struct Held {
    table: Arc<dyn SharedTable>,
    id: String,
    /// The `InHand` entry this attempt wrote: its outcome replaces only that.
    in_hand: String,
    settled: bool,
}

impl Held {
    /// Held as done when another attempt would get the same outcome, over
    /// this attempt's own `InHand` entry; deleted when not, so the next
    /// attempt is carried out afresh.
    async fn settle(mut self, digest: &str, status: StatusCode, body: Value) {
        if is_final(status) {
            let done = serde_json::to_string(&Entry::Done {
                digest: digest.to_owned(),
                status: status.as_u16(),
                body,
            })
            .expect("an entry serializes");
            match self
                .table
                .replace(self.id.clone(), self.in_hand.clone(), done)
                .await
            {
                Ok(true) => {}
                Ok(false) => logging::warn(
                    "[bus KEY-LEASE-LOST] an emit outran its lease and its key is another attempt's now; its outcome is not held",
                    json!({ "component": "bus", "status": status.as_u16() }),
                ),
                Err(error) => logging::warn(
                    "[bus KEY-SETTLE-FAILED] an emit's key could not be settled; a repeat waits out its lease",
                    json!({ "component": "bus", "status": status.as_u16(), "error": error }),
                ),
            }
        } else if let Err(error) = self.table.delete(self.id.clone()).await {
            logging::warn(
                "[bus KEY-SETTLE-FAILED] an emit's key could not be settled; a repeat waits out its lease",
                json!({ "component": "bus", "status": status.as_u16(), "error": error }),
            );
        }
        self.settled = true;
    }
}

impl Drop for Held {
    /// An attempt whose task panicked before its outcome lets its key go.
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let (table, id) = (self.table.clone(), std::mem::take(&mut self.id));
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if let Err(error) = table.delete(id).await {
                    logging::warn(
                        "[bus KEY-SETTLE-FAILED] an abandoned emit's key could not be let go; a repeat waits out its lease",
                        json!({ "component": "bus", "error": error }),
                    );
                }
            });
        }
    }
}

/// Whether another attempt would get this outcome again: an acceptance, or a
/// refusal other than 401 and 429. Any other, 5xx included, clears the key.
fn is_final(status: StatusCode) -> bool {
    status.is_success()
        || (status.is_client_error()
            && status != StatusCode::UNAUTHORIZED
            && status != StatusCode::TOO_MANY_REQUESTS)
}

fn sha256(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(ring::digest::digest(&ring::digest::SHA256, bytes))
}

/// The table's key for `principal`'s `key`.
fn table_key(principal: &str, key: &str) -> String {
    sha256(&serde_json::to_vec(&[principal, key]).expect("two strings serialize"))
}

/// What an emit's body is, whatever order its fields came in: SHA-256 of the
/// body with every object's fields sorted by name, so an attempt the client
/// serialized afresh is the same emit. The gateway builds serde_json with
/// `preserve_order`, so a parsed body keeps the order it came in.
fn digest(request: &Value) -> String {
    sha256(&serde_json::to_vec(&sorted(request)).expect("a JSON value serializes"))
}

fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            let mut fields: Vec<(&String, &Value)> = fields.iter().collect();
            fields.sort_by(|a, b| a.0.cmp(b.0));
            Value::Object(
                fields
                    .into_iter()
                    .map(|(name, field)| (name.clone(), sorted(field)))
                    .collect::<Map<String, Value>>(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        scalar => scalar.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signal::in_process::InProcessPlane;
    use std::future::{Ready, ready};
    use std::sync::atomic::{AtomicBool, Ordering};

    const ALICE: &str = "did:web:example.org:users:alice";
    const BOB: &str = "did:web:example.org:users:bob";

    /// An emit carried out as accepted, which marks `carried` when it runs.
    fn marking(
        carried: &Arc<AtomicBool>,
    ) -> impl FnOnce(Value) -> Ready<Result<BusEmitAccepted, ApiError>> {
        let carried = carried.clone();
        move |_| {
            carried.store(true, Ordering::SeqCst);
            ready(Ok(BusEmitAccepted { subscribers: None }))
        }
    }

    #[test]
    fn the_order_of_a_bodys_fields_makes_no_difference_to_its_digest() {
        let written =
            json!({ "channel": "mark:added", "payload": { "a": 1, "b": [{ "x": 1, "y": 2 }] } });
        let rewritten =
            json!({ "payload": { "b": [{ "y": 2, "x": 1 }], "a": 1 }, "channel": "mark:added" });
        assert_eq!(digest(&written), digest(&rewritten));
    }

    #[test]
    fn another_payload_is_another_digest() {
        assert_ne!(
            digest(&json!({ "channel": "mark:added", "payload": { "a": 1 } })),
            digest(&json!({ "channel": "mark:added", "payload": { "a": 2 } }))
        );
    }

    #[test]
    fn an_acceptance_and_a_refusal_another_attempt_would_get_again_are_held() {
        for status in [200, 202, 400, 403, 404, 409, 413, 422] {
            assert!(
                is_final(StatusCode::from_u16(status).expect("a status")),
                "{status} is held"
            );
        }
    }

    #[test]
    fn a_refusal_another_attempt_may_not_get_clears_the_key() {
        for status in [401, 429, 500, 502, 503, 504] {
            assert!(
                !is_final(StatusCode::from_u16(status).expect("a status")),
                "{status} clears the key"
            );
        }
    }

    #[test]
    fn one_key_of_two_principals_is_two_entries() {
        assert_ne!(table_key(ALICE, "k"), table_key(BOB, "k"));
        assert_eq!(table_key(ALICE, "k"), table_key(ALICE, "k"));
    }

    #[tokio::test]
    async fn a_key_is_forgotten_once_the_table_has_held_it_for_its_lifetime() {
        let plane = InProcessPlane::new();
        let keys = EmitKeys::lasting(&plane, Duration::from_secs(1))
            .await
            .expect("the table opens");
        let first = json!({ "channel": "mark:added", "payload": { "a": 1 } });
        let other = json!({ "channel": "mark:added", "payload": { "a": 2 } });
        let carried = Arc::new(AtomicBool::new(false));

        let answered = keys.answer(ALICE, "k", first, marking(&carried)).await;
        assert_eq!(answered.status(), StatusCode::ACCEPTED);
        carried.store(false, Ordering::SeqCst);

        let refused = keys
            .answer(ALICE, "k", other.clone(), marking(&carried))
            .await;
        assert_eq!(refused.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            !carried.load(Ordering::SeqCst),
            "a refused emit is not carried out"
        );

        tokio::time::sleep(Duration::from_millis(1100)).await;
        let again = keys.answer(ALICE, "k", other, marking(&carried)).await;
        assert_eq!(again.status(), StatusCode::ACCEPTED);
        assert!(carried.load(Ordering::SeqCst), "carried out afresh");
    }
}
