/**
 * Bounded retry with exponential backoff.
 *
 * Exists for startup-critical network calls in long-running peers (worker,
 * smelter, weaver): each authenticates against the KS the moment its
 * container starts, and the backend may not be reachable for a few seconds
 * (backend restart, container-network warm-up). Orchestration runs these
 * processes with `--rm` and no restart policy, so a process that dies on
 * the first `TypeError: fetch failed` is dead for good — the retry window
 * here is the only recovery it gets.
 */

export interface RetryPolicy {
  /** Total attempts, including the first one. */
  attempts: number;
  /** Delay before the second attempt; doubles each retry. */
  initialDelayMs: number;
  /** Ceiling for the doubled delay. */
  maxDelayMs: number;
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
 * Default policy for startup connections to the backend: 8 attempts with
 * delays 1s, 2s, 4s, then capped at 8s — ~39s of patience before giving up.
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
 * HTTP-level failures (a 401 means the backend is UP and rejected us;
 * retrying won't change its mind) and for programming errors.
 */
export function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  if (error.message === 'fetch failed') return true;
  const code = (error.cause as { code?: string } | undefined)?.code;
  return typeof code === 'string' && code.length > 0;
}

/**
 * Run `fn`, retrying on errors `isRetryable` accepts, with exponential
 * backoff per `policy`. `onRetry` fires before each wait — the caller's
 * hook for logging the attempt. The final error (retryable budget
 * exhausted, or the first non-retryable one) is rethrown verbatim.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  policy: RetryPolicy,
  onRetry?: (info: RetryAttemptInfo) => void,
): Promise<T> {
  let delayMs = policy.initialDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= policy.attempts || !isRetryable(error)) throw error;
      onRetry?.({ attempt, attempts: policy.attempts, delayMs, error });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, policy.maxDelayMs);
    }
  }
}
