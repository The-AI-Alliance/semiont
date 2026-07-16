/**
 * retryWithBackoff exists so a long-running peer whose first fetch to the
 * KS fails (backend restart, container-network warm-up) waits out the
 * blip instead of dying — orchestration runs these processes with `--rm`
 * and no restart policy, so exit-on-first-failure is permanent death.
 */
import { describe, it, expect, vi } from 'vitest';
import { retryWithBackoff, isTransientFetchError, STARTUP_FETCH_RETRY, type RetryAttemptInfo } from '../retry';

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

  it('doubles the delay each retry and caps at maxDelayMs, reporting via onRetry', async () => {
    const seen: RetryAttemptInfo[] = [];
    await expect(
      retryWithBackoff(
        async () => { throw fetchFailed(); },
        isTransientFetchError,
        { attempts: 5, initialDelayMs: 1, maxDelayMs: 4 },
        (info) => seen.push(info),
      ),
    ).rejects.toThrow();
    expect(seen.map((s) => s.delayMs)).toEqual([1, 2, 4, 4]);
    expect(seen.map((s) => s.attempt)).toEqual([1, 2, 3, 4]);
    expect(seen.every((s) => s.attempts === 5)).toBe(true);
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
