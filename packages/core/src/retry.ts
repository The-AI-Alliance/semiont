/**
 * Bounded retry with exponential backoff.
 *
 * Exists for startup-critical network calls in long-running peers (worker,
 * smelter, weaver): each authenticates against the KS the moment its
 * container starts, and the gateway may not be reachable for a few seconds
 * (gateway restart, container-network warm-up). Orchestration runs these
 * processes with `--rm` and no restart policy, so a process that dies on
 * the first `TypeError: fetch failed` is dead for good — the retry window
 * here is the only recovery it gets.
 */

import { BusRequestError } from './bus-request';

export interface RetryPolicy {
  /** Total attempts, including the first one. */
  attempts: number;
  /** Ceiling on the delay before the second attempt; doubles each retry. */
  initialDelayMs: number;
  /** Ceiling for the doubled delay. */
  maxDelayMs: number;
}

/**
 * Equal jitter: half the computed ceiling, plus a random share of the other
 * half — delay ∈ [cap/2, cap).
 *
 * Unconditional, not an option (SIDECAR-BOOT-RESILIENCE P2). Every caller of
 * `retryWithBackoff` is a container in a fleet that boots together and retries
 * against ONE gateway, which is precisely the lockstep this exists to break: N
 * peers backing off by an identical schedule re-converge on the same instant and
 * re-deliver the burst that caused the failure. A flag would leave that hazard
 * reachable by default-choosing, and nobody would ever pass `false`.
 *
 * The worst case is unchanged — `delay <= cap` still holds, so the patience
 * budget a policy advertises stays true; only the expected wait drops. Same
 * formula the SSE reconnect already uses (`actor-state-unit.ts`, D1a), so the two
 * backoffs behave alike rather than each inventing a curve.
 */
function equalJitter(cap: number): number {
  return cap / 2 + Math.random() * (cap / 2);
}

export interface RetryAttemptInfo {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** Total attempt budget from the policy. */
  attempts: number;
  /** How long we wait before the next attempt. */
  delayMs: number;
  error: unknown;
}

/**
 * The worst-case wall clock a policy can spend.
 *
 * Derived, because it was being restated by hand in three places — a docstring
 * saying "~39s", a test recomputing the sum, and a reader doing arithmetic to
 * decide whether some other deadline could cut it short. Any of those can drift
 * from the policy the moment someone edits it, and the drift is silent.
 *
 * `perAttemptMs` is the caller's per-attempt deadline. **Pass it, or the answer
 * is a lower bound rather than a ceiling**: delays are bounded by the policy, but
 * an unbounded attempt makes the total unbounded too, which is how a budget of
 * "12 attempts" ends up meaning nothing under packet loss. `0` (the default)
 * answers the delay sum alone, for a caller whose attempts cannot hang.
 *
 * Worst case, not expected: equal jitter puts each wait in [cap/2, cap), so the
 * true wait averages ~75% of this. A ceiling is what a deadline needs to clear.
 */
export function retryBudgetMs(policy: RetryPolicy, perAttemptMs = 0): number {
  let cap = policy.initialDelayMs;
  let total = perAttemptMs;
  for (let i = 1; i < policy.attempts; i++) {
    total += cap + perAttemptMs;
    cap = Math.min(cap * 2, policy.maxDelayMs);
  }
  return total;
}

/**
 * Default policy for startup connections to the gateway: 8 attempts with delay
 * ceilings 1s, 2s, 4s, then capped at 8s. `retryBudgetMs` is the authority on
 * how long that is; the equal-jittered backoff means the expected wait is ~75%
 * of the ceiling it reports.
 */
export const STARTUP_FETCH_RETRY: RetryPolicy = {
  attempts: 8,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
};

/**
 * True for the errors `fetch` throws when the connection itself fails —
 * undici's `TypeError: fetch failed` (ECONNREFUSED, ENOTFOUND, reset,
 * timeout — the socket error rides in `cause`). Deliberately false for
 * HTTP-level failures (a 401 means the gateway is UP and rejected us;
 * retrying won't change its mind) and for programming errors.
 */
export function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  if (error.message === 'fetch failed') return true;
  const code = (error.cause as { code?: string } | undefined)?.code;
  return typeof code === 'string' && code.length > 0;
}

/**
 * An error that knows the HTTP status the server answered with.
 *
 * Structural rather than a class, because the class already exists:
 * http-transport's `APIError` carries `status` and cannot be named from here
 * without inverting the package dependency. This interface is the contract
 * between the thrower and `isRetryableRequestError`, stated once — a predicate
 * that recovered the status by parsing it back out of an error MESSAGE would be
 * a second statement of the same fact, in the fragile direction.
 */
export interface HttpStatusError extends Error {
  readonly status: number;
}

/**
 * Statuses that mean *up, but not now* — the server is answering, and its
 * answer is "try again".
 *
 *  - `429` — the gateway's own rate limiter; its body says to retry when one
 *            settles. Retrying is compliance, not hope.
 *  - `503` — unavailable, explicitly temporary by RFC 9110.
 *  - `504` — an upstream deadline, which the next attempt may well beat.
 *
 * Everything else is excluded deliberately, including `500`: 503 and 504 are
 * promises to recover, while an unclassified server fault is not — retrying it
 * inside a boot pass just replays whatever broke it.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 503, 504]);

/**
 * True for failures worth another attempt: the connection never landed
 * (`isTransientFetchError`), the server answered "not now"
 * (`RETRYABLE_STATUSES`), or our own deadline expired.
 *
 * The timeout case is the one that is easy to get wrong. `AbortSignal.timeout()`
 * rejects with a **DOMException named `TimeoutError`**, not a `TypeError` —
 * measured, not assumed — so `isTransientFetchError` cannot see it, and a
 * request that bounded itself was unretryable precisely when the bound fired.
 * Matched by `name` rather than `instanceof DOMException` because the constructor
 * is not guaranteed present in every runtime this package builds for, while the
 * name is part of the DOM spec.
 *
 * Auth and validation failures stay excluded, preserving `isTransientFetchError`'s
 * reasoning verbatim: a 401 means the gateway is UP and rejected us, and retrying
 * will not change its mind. A 429 differs — the gateway is up and *asking* us to
 * wait, so the same "it answered" fact points the other way.
 */
/**
 * True when the service that answers a bus channel has not connected yet.
 *
 * A startup race, not a refusal: the gateway synthesizes this when a request's
 * channel has no subscriber, and the peer it is waiting for is usually seconds
 * away. The weaver's boot passes used to treat it as a data condition and give up
 * for the life of the process — an empty graph projection behind a healthy
 * `/health`, with live traffic then advancing the applied mark past events that
 * were never projected (2026-09-09).
 *
 * Narrow on purpose, and note what it EXCLUDES: `bus.unsubscribed` means *this*
 * transport is not subscribed to the reply channel — a local misconfiguration
 * caught before emitting, which retrying cannot fix and would only delay. The two
 * codes sound alike and mean opposite ends of the same wire; the predicate is
 * where that distinction has to hold.
 *
 * Takes a `BusRequestError` rather than any `{ code }` object: the code is a wire
 * value, and `busRequest` is the one place it is mapped into this vocabulary. An
 * object that did not come through there has not been classified.
 */
export function isPeerUnavailable(error: unknown): boolean {
  return error instanceof BusRequestError && error.code === 'bus.peer-unavailable';
}

export function isRetryableRequestError(error: unknown): boolean {
  if (isTransientFetchError(error)) return true;
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { name?: unknown }).name === 'TimeoutError') return true;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && RETRYABLE_STATUSES.has(status);
}

/**
 * Run `fn`, retrying on errors `isRetryable` accepts, with equal-jitter
 * exponential backoff per `policy`. `onRetry` fires before each wait — the
 * caller's hook for logging the attempt, and it reports the actual jittered
 * delay. The final error (retryable budget exhausted, or the first
 * non-retryable one) is rethrown verbatim.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  policy: RetryPolicy,
  onRetry?: (info: RetryAttemptInfo) => void,
): Promise<T> {
  let cap = policy.initialDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= policy.attempts || !isRetryable(error)) throw error;
      // `delayMs` reported to `onRetry` is the ACTUAL wait, not the ceiling —
      // a log that printed the ceiling would describe a schedule nobody ran.
      const delayMs = equalJitter(cap);
      onRetry?.({ attempt, attempts: policy.attempts, delayMs, error });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      cap = Math.min(cap * 2, policy.maxDelayMs);
    }
  }
}
