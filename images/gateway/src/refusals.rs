//! Refused requests per holder (the bearer scheme's `x-semiont-limits`): a
//! token bucket for each holder a refused token names, read without verifying
//! it, and one shared by every request that names none. Consulted only once a
//! credential is refused, so a token that verifies is never limited, whatever
//! its holder's count. Per gateway process, as the emit buckets are.

use crate::limits::{self, RefusalLimit};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Whom a refused request is counted against.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Holder {
    /// The token's `iss`, and the holder it names.
    Named { issuer: String, holder: String },
    /// No token, or one that names no `iss` or no holder.
    Unnamed,
}

struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn full(now: Instant, limit: RefusalLimit) -> Bucket {
        Bucket {
            tokens: limit.burst as f64,
            at: now,
        }
    }

    /// Take one refusal from the bucket, or say how long until one is there.
    fn take(&mut self, now: Instant, limit: RefusalLimit) -> Result<(), Duration> {
        let earned = now.duration_since(self.at).as_secs_f64() * limit.per_second as f64;
        self.tokens = (self.tokens + earned).min(limit.burst as f64);
        self.at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            Ok(())
        } else {
            Err(Duration::from_secs_f64(
                (1.0 - self.tokens) / limit.per_second as f64,
            ))
        }
    }
}

#[derive(Default)]
struct Counts {
    named: HashMap<(String, String), Bucket>,
    /// The named holders in the order they were first counted: the front is dropped first.
    order: VecDeque<(String, String)>,
    unnamed: Option<Bucket>,
}

#[derive(Default)]
pub struct Refusals {
    counts: Mutex<Counts>,
}

impl Refusals {
    /// Count one refusal against `holder`: `Err` with the wait, once its
    /// allowance is used.
    pub fn count(&self, holder: Holder) -> Result<(), Duration> {
        self.count_at(holder, Instant::now(), limits::limits().refusals)
    }

    fn count_at(&self, holder: Holder, now: Instant, limit: RefusalLimit) -> Result<(), Duration> {
        let mut guard = self.counts.lock().unwrap_or_else(|p| p.into_inner());
        let counts = &mut *guard;
        let bucket = match holder {
            Holder::Unnamed => counts
                .unnamed
                .get_or_insert_with(|| Bucket::full(now, limit)),
            Holder::Named { issuer, holder } => {
                let key = (issuer, holder);
                if !counts.named.contains_key(&key) {
                    if counts.named.len() >= limit.holders
                        && let Some(first) = counts.order.pop_front()
                    {
                        counts.named.remove(&first);
                    }
                    counts.order.push_back(key.clone());
                }
                counts
                    .named
                    .entry(key)
                    .or_insert_with(|| Bucket::full(now, limit))
            }
        };
        bucket.take(now, limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMIT: RefusalLimit = RefusalLimit {
        per_second: 10,
        burst: 3,
        holders: 2,
    };

    fn named(holder: &str) -> Holder {
        Holder::Named {
            issuer: "kb.example".to_owned(),
            holder: holder.to_owned(),
        }
    }

    #[test]
    fn a_holder_is_refused_its_burst_and_then_told_how_long_to_wait() {
        let refusals = Refusals::default();
        let now = Instant::now();
        for _ in 0..LIMIT.burst {
            assert_eq!(refusals.count_at(named("a"), now, LIMIT), Ok(()));
        }
        let wait = refusals.count_at(named("a"), now, LIMIT).unwrap_err();
        assert!(wait > Duration::ZERO && wait <= Duration::from_millis(100));
        // A tenth of a second at ten a second earns one back.
        let later = now + Duration::from_millis(100);
        assert_eq!(refusals.count_at(named("a"), later, LIMIT), Ok(()));
    }

    #[test]
    fn holders_are_counted_apart_and_apart_from_requests_that_name_none() {
        let refusals = Refusals::default();
        let now = Instant::now();
        for _ in 0..LIMIT.burst {
            refusals.count_at(named("a"), now, LIMIT).unwrap();
        }
        assert!(refusals.count_at(named("a"), now, LIMIT).is_err());
        assert_eq!(refusals.count_at(named("b"), now, LIMIT), Ok(()));
        assert_eq!(refusals.count_at(Holder::Unnamed, now, LIMIT), Ok(()));
    }

    #[test]
    fn past_its_size_the_table_drops_the_holder_it_began_counting_first() {
        let refusals = Refusals::default();
        let now = Instant::now();
        for _ in 0..LIMIT.burst {
            refusals.count_at(named("first"), now, LIMIT).unwrap();
        }
        refusals.count_at(named("second"), now, LIMIT).unwrap();
        // A third holder: the table holds two, so the first is dropped.
        refusals.count_at(named("third"), now, LIMIT).unwrap();
        assert_eq!(
            refusals.count_at(named("first"), now, LIMIT),
            Ok(()),
            "dropped, the first starts again with its whole allowance"
        );
    }

    #[test]
    fn requests_that_name_no_holder_share_one_count_that_is_never_dropped() {
        let refusals = Refusals::default();
        let now = Instant::now();
        for _ in 0..LIMIT.burst {
            refusals.count_at(Holder::Unnamed, now, LIMIT).unwrap();
        }
        for holder in ["a", "b", "c"] {
            refusals.count_at(named(holder), now, LIMIT).unwrap();
        }
        assert!(refusals.count_at(Holder::Unnamed, now, LIMIT).is_err());
    }
}
