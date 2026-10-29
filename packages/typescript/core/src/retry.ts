/**
 * Retry: the mechanism, and the classifications core itself owns.
 *
 * At its centre is `retryWithBackoff`, for startup-critical calls in long-running
 * peers — each authenticates the moment its container starts, the gateway may not
 * be reachable for a few seconds, and orchestration runs them with `--rm` and no
 * restart policy, so a process that dies on the first `TypeError: fetch failed` is
 * dead for good.
 *
 * **What lives HERE — the mechanism, because it is one fact each:**
 *   - `RetryPolicy` / `retryWithBackoff` — the loop, deadline-aware
 *   - `equalJitter` — the backoff curve, shared with the SSE reconnect
 *   - the predicates that narrow an error type CORE owns (`isTransientFetchError`
 *     over `fetch`'s `TypeError`, `isRetryableRequestError` over `HttpStatusError`)
 *
 * **What deliberately does NOT — the judgment, because each is local knowledge:**
 *   - **policies.** `EMIT_RETRY` (http-transport). A policy answers *how long
 *     does THIS wait*, and a centralized one gets borrowed: a path waiting out
 *     a model download on `STARTUP_FETCH_RETRY` — sized for "until a peer
 *     starts listening" — sees its ceiling expire just before the thing it is
 *     waiting for arrives. Two facts that happen to be measured in seconds are
 *     still two facts.
 *   - **deadlines.** Each sits with the call it bounds.
 *   - **predicates over another package's errors.** Core has no business
 *     knowing that a provider's 404 means "not pulled yet".
 *
 * `STARTUP_FETCH_RETRY` is the one policy here, and only because every boot
 * path asks the one question it answers.
 *
 * **Deadlines beat budgets.** `retryWithBackoff` takes an optional `AbortSignal`
 * so a caller racing its own timeout can stop the retry, instead of the two
 * numbers having to be kept compatible by hand across packages. That is the
 * `context.Context` / gRPC-deadline move, with the platform's own primitive.
 */

import { RETRY_RULES } from './retry-rules';
import { UnansweredError } from './unanswered';

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
 * **One home, because it is one fact.** `retryWithBackoff` and the SSE reconnect
 * loop (`actor-state-unit.ts`) both need it, and a copy in each would be two
 * implementations agreeing by coincidence, free to drift the first time
 * either is tuned. The reconnect computes its own ceiling (`reconnectMs · 2ⁿ`,
 * capped); only the jitter is shared, which is the part that must not diverge.
 *
 * Unconditional in `retryWithBackoff`, not an option. Every caller of
 * `retryWithBackoff` is a container in a fleet that boots together and retries
 * against ONE gateway, which is precisely the lockstep this exists to break: N
 * peers backing off by an identical schedule re-converge on the same instant and
 * re-deliver the burst that caused the failure. A flag would leave that hazard
 * reachable by default-choosing, and nobody would ever pass `false`.
 *
 * The worst case is unchanged — `delay <= cap` still holds, so the patience
 * budget a policy advertises stays true; only the expected wait drops, to ~75%.
 */
export function equalJitter(cap: number): number {
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
 * Default policy for startup connections to the gateway: 8 attempts with delay
 * ceilings 1s, 2s, 4s, then capped at 8s. The equal-jittered backoff means
 * the expected wait is ~75% of the sum of those ceilings.
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
  /** The wait the response's `Retry-After` stated, in milliseconds; none when it stated none. */
  readonly retryAfterMs: number | undefined;
}

/**
 * A `Retry-After` header's wait in milliseconds, when it states one in seconds
 * — the form the gateway sends (`TooManyRequests`, `AtCapacity`); none
 * otherwise.
 */
export function retryAfterMs(header: string | null): number | undefined {
  return header !== null && /^[0-9]+$/.test(header.trim()) ? Number(header.trim()) * 1000 : undefined;
}

/**
 * True for failures worth another attempt: the connection never landed
 * (`isTransientFetchError`), the request got no answer (`UnansweredError`),
 * the server answered "not now" (`RETRY_RULES.boot`), or our own deadline
 * expired.
 *
 * The status half is DERIVED from `RETRY_RULES.boot` rather than restated here.
 * A private set of the same statuses would make the taxonomy a second opinion
 * instead of the answer — and a second opinion in the same package is the exact
 * defect the `RETRY_RULES` catalog exists to remove. The reasoning for those
 * statuses, and for excluding `500`, lives once, in the rule.
 *
 * The timeout case is the one that is easy to get wrong. `AbortSignal.timeout()`
 * rejects with a **DOMException named `TimeoutError`**, not a `TypeError` —
 * measured, not assumed — so `isTransientFetchError` cannot see it, and without
 * this case a request that bounds itself is unretryable precisely when the
 * bound fires. Matched by `name` rather than `instanceof DOMException` because
 * the constructor is not guaranteed present in every runtime this package
 * builds for, while the name is part of the DOM spec.
 *
 * Auth and validation failures stay excluded, preserving `isTransientFetchError`'s
 * reasoning verbatim: a 401 means the gateway is UP and rejected us, and retrying
 * will not change its mind. A 429 differs — the gateway is up and *asking* us to
 * wait, so the same "it answered" fact points the other way.
 */
export function isRetryableRequestError(error: unknown): boolean {
  if (isTransientFetchError(error) || error instanceof UnansweredError) return true;
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { name?: unknown }).name === 'TimeoutError') return true;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && RETRY_RULES.boot.retryable({ status });
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
  signal?: AbortSignal,
): Promise<T> {
  let cap = policy.initialDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // The caller's deadline outranks the budget. Without this, a caller that
      // races its own timeout against work that retries has two numbers it must
      // keep compatible by hand — and the day they stop being compatible, the
      // race kills a retry that was about to succeed.
      //
      // Checked BETWEEN attempts, not during one: the in-flight call carries its
      // own deadline (`/bus/emit`'s EMIT_TIMEOUT_MS, the providers'
      // EMBED_ROUND_TRIP_TIMEOUT_MS), so the worst overshoot is that one bound rather than
      // unbounded. Threading the signal into every leaf call would close that gap
      // and is not worth its plumbing.
      if (signal?.aborted) throw error;
      if (attempt >= policy.attempts || !isRetryable(error)) throw error;
      // `delayMs` reported to `onRetry` is the ACTUAL wait, not the ceiling —
      // a log that printed the ceiling would describe a schedule nobody ran.
      // A wait the server stated (`Retry-After`) is a floor under it: a
      // refused caller backs off by the server's clock, not its own.
      const stated = (error as { retryAfterMs?: unknown }).retryAfterMs;
      const delayMs = Math.max(equalJitter(cap), typeof stated === 'number' ? stated : 0);
      onRetry?.({ attempt, attempts: policy.attempts, delayMs, error });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      cap = Math.min(cap * 2, policy.maxDelayMs);
    }
  }
}
