/**
 * Bounded concurrency (DETECTION-QUALITY-THROUGHPUT P6). The cap is the whole
 * reason this exists — parallelism without a bound is 429 thrash — so the
 * central test is that in-flight work never exceeds the limit.
 */

import { describe, it, expect, vi } from 'vitest';
import { runBounded } from '../../../workers/detection/bounded-concurrency';

/** A worker that records the max number ever in flight at once. */
function trackingWorker(delayMs = 5) {
  let inFlight = 0;
  let maxInFlight = 0;
  const worker = async (n: number): Promise<number> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, delayMs));
    inFlight--;
    return n * 2;
  };
  return { worker, get maxInFlight() { return maxInFlight; } };
}

describe('runBounded', () => {
  it('never exceeds the limit, even with far more items', async () => {
    const t = trackingWorker();
    await runBounded([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, t.worker);
    expect(t.maxInFlight).toBeLessThanOrEqual(3);
  });

  it('actually uses the concurrency — a limit of 3 runs 3 at once', async () => {
    const t = trackingWorker();
    await runBounded([1, 2, 3, 4, 5, 6], 3, t.worker);
    expect(t.maxInFlight).toBe(3);
  });

  it('returns results in INPUT order regardless of completion order', async () => {
    // Later items finish sooner — completion order is reversed, input order must survive.
    const results = await runBounded([1, 2, 3, 4], 4, async (n) => {
      await new Promise((r) => setTimeout(r, (5 - n) * 5));
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40]);
  });

  it('processes every item exactly once', async () => {
    const seen: number[] = [];
    await runBounded([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); return n; });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('a limit at or above the item count runs them all together', async () => {
    const t = trackingWorker();
    await runBounded([1, 2, 3], 10, t.worker);
    expect(t.maxInFlight).toBe(3);
  });

  it('an empty list is a no-op', async () => {
    const worker = vi.fn(async (n: number) => n);
    const results = await runBounded([], 4, worker);
    expect(results).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it('propagates a worker rejection', async () => {
    await expect(
      runBounded([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
