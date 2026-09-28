//! Emits per principal: a token bucket per DID in this process, sized by the
//! principal's roles (`x-semiont-limits.emitsPerPrincipal`). Whether the DID
//! names a person or an agent makes no difference; a role whose coefficient is
//! unlimited means no bucket at all. The spec states the rate per gateway
//! process: counting across replicas would put a broker round trip on every emit.

use crate::principal::Principal;
use crate::spec::{EmitRate, spec};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Buckets held before the full ones are dropped: a full bucket is what a
/// principal that has not emitted lately would be given afresh.
const BUCKETS_BEFORE_SWEEP: usize = 4096;

struct Bucket {
    tokens: f64,
    at: Instant,
    rate: EmitRate,
}

impl Bucket {
    fn refilled(&self, now: Instant) -> f64 {
        let earned = now.duration_since(self.at).as_secs_f64() * self.rate.per_second as f64;
        (self.tokens + earned).min(self.rate.burst as f64)
    }
}

#[derive(Default)]
pub struct EmitRates {
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl EmitRates {
    /// Take one emit from `principal`'s bucket, or say how long until one is there.
    pub fn admit(&self, principal: &Principal) -> Result<(), Duration> {
        let roles = principal.roles.as_deref().unwrap_or_default();
        let Some(rate) = spec().limits().emits_per_principal.for_roles(roles) else {
            return Ok(());
        };
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap_or_else(|p| p.into_inner());
        if buckets.len() >= BUCKETS_BEFORE_SWEEP {
            buckets.retain(|_, bucket| bucket.refilled(now) < bucket.rate.burst as f64);
        }
        let bucket = buckets.entry(principal.did.clone()).or_insert(Bucket {
            tokens: rate.burst as f64,
            at: now,
            rate,
        });
        bucket.rate = rate;
        bucket.tokens = bucket.refilled(now);
        bucket.at = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            Err(Duration::from_secs_f64(
                (1.0 - bucket.tokens) / rate.per_second as f64,
            ))
        }
    }
}
