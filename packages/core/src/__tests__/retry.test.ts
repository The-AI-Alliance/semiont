/**
 * retryWithBackoff exists so a long-running peer whose first fetch to the
 * KS fails (gateway restart, container-network warm-up) waits out the
 * blip instead of dying — orchestration runs these processes with `--rm`
 * and no restart policy, so exit-on-first-failure is permanent death.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  retryWithBackoff,
  isTransientFetchError,
  isRetryableRequestError,
  STARTUP_FETCH_RETRY,
  type RetryAttemptInfo,
  type HttpStatusError,
} from '../retry';

const FAST = { attempts: 4, initialDelayMs: 1, maxDelayMs: 4 };

function fetchFailed(): TypeError {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4000'), { code: 'ECONNREFUSED' }),
  });
}

describe('retryWithBackoff', () => {
  it('returns the first success after transient failures', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) throw fetchFailed();
        return 'up';
      },
      isTransientFetchError,
      FAST,
    );
    expect(result).toBe('up');
    expect(calls).toBe(3);
  });

  it('rethrows a non-retryable error immediately, without consuming the budget', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new Error('Authentication failed: 401 Unauthorized');
        },
        isTransientFetchError,
        FAST,
      ),
    ).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it('exhausts the budget and rethrows the last error', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw fetchFailed();
        },
        isTransientFetchError,
        FAST,
      ),
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(FAST.attempts);
  });

  it('doubles the delay ceiling each retry and caps at maxDelayMs, reporting via onRetry', async () => {
    const seen: RetryAttemptInfo[] = [];
    await expect(
      retryWithBackoff(
        async () => { throw fetchFailed(); },
        isTransientFetchError,
        { attempts: 5, initialDelayMs: 8, maxDelayMs: 32 },
        (info) => seen.push(info),
      ),
    ).rejects.toThrow();
    // Equal jitter (SIDECAR-BOOT-RESILIENCE P2): each wait is in [cap/2, cap),
    // so the exact sequence is no longer assertable — but the SCHEDULE is: the
    // ceilings still double and still cap, and the reported delay is the actual
    // wait rather than the ceiling. Asserting per-attempt bounds keeps both the
    // doubling and the cap under test without pinning the random draw.
    const caps = [8, 16, 32, 32];
    expect(seen).toHaveLength(caps.length);
    seen.forEach((info, i) => {
      expect(info.delayMs, `attempt ${i + 1}`).toBeGreaterThanOrEqual(caps[i]! / 2);
      expect(info.delayMs, `attempt ${i + 1}`).toBeLessThan(caps[i]!);
    });
    expect(seen.map((s) => s.attempt)).toEqual([1, 2, 3, 4]);
    expect(seen.every((s) => s.attempts === 5)).toBe(true);
  });

  it('jitters: repeated runs of the same policy do not produce identical delays', async () => {
    // The property that matters is DIVERGENCE — N peers backing off by an
    // identical schedule re-converge on the same instant and re-deliver the
    // burst that caused the failure. A fixed schedule would make every run here
    // equal; over 12 runs the chance of a false failure is negligible.
    const firstDelays: number[] = [];
    for (let run = 0; run < 12; run++) {
      await expect(
        retryWithBackoff(
          async () => { throw fetchFailed(); },
          isTransientFetchError,
          { attempts: 2, initialDelayMs: 8, maxDelayMs: 8 },
          (info) => firstDelays.push(info.delayMs),
        ),
      ).rejects.toThrow();
    }
    expect(new Set(firstDelays).size).toBeGreaterThan(1);
  });

  it('does not call setTimeout on the success path', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      await retryWithBackoff(async () => 'ok', isTransientFetchError, FAST);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('isTransientFetchError', () => {
  it("accepts undici's TypeError('fetch failed')", () => {
    expect(isTransientFetchError(fetchFailed())).toBe(true);
  });

  it('accepts a TypeError carrying a socket error code in cause', () => {
    const err = Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    });
    expect(isTransientFetchError(err)).toBe(true);
  });

  it('rejects HTTP-level and programming errors', () => {
    expect(isTransientFetchError(new Error('Authentication failed: 503'))).toBe(false);
    expect(isTransientFetchError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isTransientFetchError('fetch failed')).toBe(false);
  });
});

describe('isRetryableRequestError (SIDECAR-BOOT-RESILIENCE P1)', () => {
  /** What a status-carrying transport error looks like to this predicate. The
   *  real one is http-transport's `APIError`, which already carries `status`. */
  const withStatus = (status: number): HttpStatusError =>
    Object.assign(new Error(`/bus/emit ${status}`), { status });

  it('accepts 429 — the gateway is UP and asking us to wait', () => {
    // The whole reason this predicate exists. `isTransientFetchError` refuses
    // every HTTP-level failure by design, and its reasoning ("a 401 means the
    // gateway is up and rejected us") is right for 401 and wrong for 429: a 429
    // is the server's own instruction to try again.
    expect(isTransientFetchError(withStatus(429))).toBe(false);
    expect(isRetryableRequestError(withStatus(429))).toBe(true);
  });

  it('accepts 503 and 504 — up, but not now', () => {
    expect(isRetryableRequestError(withStatus(503))).toBe(true);
    expect(isRetryableRequestError(withStatus(504))).toBe(true);
  });

  it('rejects auth and validation failures — retrying cannot change their minds', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableRequestError(withStatus(status)), String(status)).toBe(false);
    }
  });

  it('rejects a bare 500 — an unclassified server fault is not a promise to recover', () => {
    // 503/504 say "come back"; 500 says "something broke". Retrying a 500 in a
    // boot pass replays the request that broke it.
    expect(isRetryableRequestError(withStatus(500))).toBe(false);
  });

  it("accepts AbortSignal.timeout's TimeoutError — a deadline IS 'try again'", () => {
    // Measured, not assumed: `AbortSignal.timeout()` rejects with a DOMException
    // named 'TimeoutError', NOT a TypeError — so `isTransientFetchError` cannot
    // see it, and the bounded `/bus/emit` was unretryable on timeout.
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(isTransientFetchError(timeout)).toBe(false);
    expect(isRetryableRequestError(timeout)).toBe(true);
  });

  it('still accepts everything isTransientFetchError does — the two compose', () => {
    expect(isRetryableRequestError(fetchFailed())).toBe(true);
    expect(isRetryableRequestError(Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    }))).toBe(true);
  });

  it('rejects errors with no status and no connection failure', () => {
    expect(isRetryableRequestError(new Error('something else'))).toBe(false);
    expect(isRetryableRequestError('429')).toBe(false);
    expect(isRetryableRequestError(undefined)).toBe(false);
    // A status that is not a number is not a status — never coerce.
    expect(isRetryableRequestError(Object.assign(new Error('x'), { status: '429' }))).toBe(false);
  });
});

describe('STARTUP_FETCH_RETRY', () => {
  it('waits ~39s worst case — inside the 30–60s startup window', () => {
    let delay = STARTUP_FETCH_RETRY.initialDelayMs;
    let total = 0;
    for (let i = 1; i < STARTUP_FETCH_RETRY.attempts; i++) {
      total += delay;
      delay = Math.min(delay * 2, STARTUP_FETCH_RETRY.maxDelayMs);
    }
    expect(total).toBeGreaterThanOrEqual(30_000);
    expect(total).toBeLessThanOrEqual(60_000);
  });
});
