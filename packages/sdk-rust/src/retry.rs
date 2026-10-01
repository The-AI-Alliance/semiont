//! Retrying: which failures are worth another attempt, and how long to keep
//! trying.
//!
//! The two are separate questions. A `RetryRule` answers the first for one
//! context, and the four contexts answer differently on purpose: a `500` in
//! the middle of a job is worth another attempt, where the same `500` in a
//! boot pass replays whatever broke it. A `RetryPolicy` answers the second: a
//! budget of attempts and the backoff between them. Every implementation
//! answers the first as specs/src/retry/cases.json states, which this crate's
//! tests run; the budgets a client keeps are specs/src/client/timing.json's
//! (`crate::timing`).

use std::future::Future;
use std::time::Duration;

/// A budget: `attempts` in all, the first included, with a wait before each
/// further one that starts at `initial_delay` and doubles to `max_delay`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub attempts: u32,
    pub initial_delay: Duration,
    pub max_delay: Duration,
}

/// What is known of a failure when someone asks whether to try again. A
/// status or a method that is not stated is `None`, and an unstated method
/// reads as one that is not safe to repeat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RetryFacts<'a> {
    pub status: Option<u16>,
    pub method: Option<&'a str>,
}

/// Which failures one context tries again.
pub struct RetryRule {
    pub name: &'static str,
    retryable: fn(&RetryFacts<'_>) -> bool,
}

impl RetryRule {
    pub fn retryable(&self, facts: &RetryFacts<'_>) -> bool {
        (self.retryable)(facts)
    }
}

/// Repeating these cannot cause a second effect upstream (RFC 9110 §9.2.2).
const IDEMPOTENT_METHODS: [&str; 6] = ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"];

/// A boot pass or a bus request, where the peer is usually seconds from being
/// ready: the statuses that say "up, but not now". A `500` is not among them:
/// replaying it in a boot pass re-runs whatever broke it.
pub const BOOT: RetryRule = RetryRule {
    name: "boot",
    retryable: |facts| matches!(facts.status, Some(429 | 503 | 504)),
};

/// A job's retry budget, where not retrying discards a long attempt already
/// paid for: any server fault, a limit, and an explicit timeout.
pub const JOB: RetryRule = RetryRule {
    name: "job",
    retryable: |facts| matches!(facts.status, Some(status) if status == 408 || status == 429 || status >= 500),
};

/// An HTTP client that can renew its token. A `401` is retried on any method:
/// the request was rejected, not processed, and a renewed token makes it
/// valid. Every other retryable status applies only to a method that cannot
/// cause a second effect, because a POST answered `502` may already have been
/// processed.
pub const TRANSPORT: RetryRule = RetryRule {
    name: "transport",
    retryable: |facts| {
        let Some(status) = facts.status else {
            return false;
        };
        if status == 401 {
            return true;
        }
        let repeatable = facts.method.is_some_and(|method| {
            IDEMPOTENT_METHODS
                .iter()
                .any(|m| m.eq_ignore_ascii_case(method))
        });
        repeatable && matches!(status, 408 | 413 | 429 | 500 | 502 | 503 | 504)
    },
};

/// Exchanging a refresh token at its issuer. The issuer's answer is the
/// verdict and its absence never is: no response at all, or one saying "not
/// now", is transient; a refused grant, and any fault this rule does not
/// name, is terminal, because retrying only delays a sign-in the user must
/// perform anyway.
pub const REFRESH: RetryRule = RetryRule {
    name: "refresh",
    retryable: |facts| match facts.status {
        None => true,
        Some(status) => status == 408 || status == 429 || status >= 500,
    },
};

/// Every rule: a rule that is not here cannot be reached.
pub const RETRY_RULES: [&RetryRule; 4] = [&BOOT, &JOB, &REFRESH, &TRANSPORT];

/// The wait a `Retry-After` header states, when it gives whole seconds, the
/// form the gateway sends; none otherwise.
pub fn retry_after(header: Option<&str>) -> Option<Duration> {
    let stated = header?.trim();
    if stated.is_empty() || !stated.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    stated.parse::<u64>().ok().map(Duration::from_secs)
}

/// Equal jitter: half of `cap`, and a random share of the other half. Callers
/// that back off by one schedule against one gateway re-converge on the same
/// instant and deliver again the burst that failed; the random half keeps them
/// apart, and the wait never exceeds `cap`.
pub fn equal_jitter(cap: Duration) -> Duration {
    // 53 random bits: every one a double holds exactly.
    let share = (uuid::Uuid::new_v4().as_u128() >> 75) as f64 / (1u64 << 53) as f64;
    cap.div_f64(2.0) + cap.div_f64(2.0).mul_f64(share)
}

/// Run `attempt` until it succeeds, `policy`'s attempts are spent, or it
/// fails in a way `retryable` does not accept. The wait before each further
/// attempt is the policy's jittered backoff, and never less than the wait the
/// failure itself stated (`stated_wait`: a refusal's `Retry-After`). The last
/// failure is returned as it was.
pub async fn retry_with_backoff<T, E, F>(
    policy: RetryPolicy,
    mut attempt: impl FnMut() -> F,
    retryable: impl Fn(&E) -> bool,
    stated_wait: impl Fn(&E) -> Option<Duration>,
) -> Result<T, E>
where
    F: Future<Output = Result<T, E>>,
{
    let mut cap = policy.initial_delay;
    let mut made = 1;
    loop {
        let error = match attempt().await {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };
        if made >= policy.attempts || !retryable(&error) {
            return Err(error);
        }
        let wait = equal_jitter(cap).max(stated_wait(&error).unwrap_or_default());
        tokio::time::sleep(wait).await;
        cap = (cap * 2).min(policy.max_delay);
        made += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jitter_stays_between_half_the_cap_and_the_cap() {
        let cap = Duration::from_millis(1000);
        for _ in 0..1000 {
            let wait = equal_jitter(cap);
            assert!(wait >= cap / 2 && wait <= cap, "{wait:?}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_budget_is_spent_and_the_last_failure_returned() {
        let policy = RetryPolicy {
            attempts: 3,
            initial_delay: Duration::from_millis(10),
            max_delay: Duration::from_millis(20),
        };
        let mut made = 0;
        let outcome: Result<(), u32> = retry_with_backoff(
            policy,
            || {
                made += 1;
                let n = made;
                async move { Err(n) }
            },
            |_| true,
            |_| None,
        )
        .await;
        assert_eq!(outcome, Err(3));
    }

    #[tokio::test(start_paused = true)]
    async fn a_failure_not_worth_retrying_ends_at_once() {
        let policy = RetryPolicy {
            attempts: 4,
            initial_delay: Duration::from_millis(10),
            max_delay: Duration::from_millis(20),
        };
        let mut made = 0;
        let outcome: Result<(), u32> = retry_with_backoff(
            policy,
            || {
                made += 1;
                async { Err(400) }
            },
            |status| *status == 429,
            |_| None,
        )
        .await;
        assert_eq!(outcome, Err(400));
        assert_eq!(made, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stated_wait_is_a_floor_under_the_backoff() {
        let policy = RetryPolicy {
            attempts: 2,
            initial_delay: Duration::from_millis(10),
            max_delay: Duration::from_millis(10),
        };
        let started = tokio::time::Instant::now();
        let mut made = 0;
        let outcome: Result<u32, u32> = retry_with_backoff(
            policy,
            || {
                made += 1;
                let n = made;
                async move { if n == 1 { Err(429) } else { Ok(n) } }
            },
            |_| true,
            |_| Some(Duration::from_secs(5)),
        )
        .await;
        assert_eq!(outcome, Ok(2));
        assert!(started.elapsed() >= Duration::from_secs(5));
    }
}
