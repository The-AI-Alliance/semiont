/**
 * Run `worker` over `items` with at most `limit` of them in flight at once
 * (DETECTION-QUALITY-THROUGHPUT P6). Hand-rolled rather than a dependency: the
 * need is exactly one bounded map, and the BOUND is the whole point — detection
 * parallelizes independent entity types, but unbounded fan-out just trades
 * sequential waiting for provider 429 thrash, so the cap is the feature.
 *
 * A fixed pool of `min(limit, items.length)` pumps, each pulling the next index
 * until the work is exhausted — so at most `limit` calls are ever awaiting at
 * once, whatever the item count. Results are returned in INPUT order (a caller
 * can zip them back to items); COMPLETION order is not input order — that is the
 * point of concurrency — so a caller that must act "as each finishes" does so
 * inside `worker`, not on the returned array.
 *
 * Failure matches the sequential loop it replaces: the first `worker` rejection
 * rejects the whole run. Pumps already awaiting finish (they cannot be
 * cancelled mid-await), but no new item is pulled once a rejection propagates.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function pump(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }

  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => pump()));
  return results;
}
