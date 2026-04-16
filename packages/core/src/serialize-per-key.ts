/**
 * serializePerKey — run async work serialized per key, parallel across keys.
 *
 * Invariant: two calls with the same `key` run strictly in sequence (the
 * second `work` does not start until the first has settled). Calls with
 * different keys overlap freely.
 *
 * Error isolation: a rejected work function does not poison subsequent
 * tasks for the same key. The next task starts fresh from whatever state
 * the failed task left behind. The rejection still propagates to *this*
 * caller.
 *
 * Registry cleanup: the entry for a key is removed as soon as its chain
 * empties, so the Map stays bounded by the number of keys with work
 * currently in flight, not by the total number of keys ever seen.
 *
 * ## Usage
 *
 * ```ts
 * const chains = new Map<string, Promise<void>>();
 *
 * async function write(resourceId: string, event: Event) {
 *   return serializePerKey(resourceId, chains, async () => {
 *     // Read-modify-write on a view file. Any two concurrent calls with
 *     // the same resourceId will be serialized; different resourceIds
 *     // will proceed in parallel.
 *     const view = await viewStorage.get(resourceId);
 *     applyEvent(view, event);
 *     await viewStorage.save(resourceId, view);
 *   });
 * }
 * ```
 *
 * ## When to use this vs RxJS `groupBy + concatMap`
 *
 * Use `serializePerKey` when the work arrives as **direct method calls**
 * that need to block the caller until completion. This is the RPC shape
 * — think `EventStore.appendEvent` calling `await views.materializeResource(...)`
 * and needing the view written before any subscriber sees the published
 * event.
 *
 * Use RxJS `groupBy(keyFn) + concatMap(...)` when the work arrives as an
 * **event stream** that a component subscribes to once at startup. This
 * is how `Smelter`, `GraphDBConsumer`, and `Gatherer` serialize their own
 * per-resource work — see their implementations in `packages/make-meaning`.
 *
 * Both patterns solve the same logical problem ("serialize work per key").
 * The choice is dictated by whether the caller is awaiting the result.
 */
export async function serializePerKey<K, T>(
  key: K,
  chains: Map<K, Promise<void>>,
  work: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();

  // Chain onto prev, swallowing any error from the previous link so one
  // bad task doesn't poison subsequent ones for the same key. The new
  // link's own errors still propagate to our caller via `await next`.
  let result: T;
  const next = prev
    .catch(() => { /* prior failure doesn't block us */ })
    .then(async () => {
      result = await work();
    });

  chains.set(key, next);

  try {
    await next;
    return result!;
  } finally {
    // Only clear the entry if we're still the tail. If another caller
    // has already chained onto us, leave it so the chain stays intact.
    if (chains.get(key) === next) {
      chains.delete(key);
    }
  }
}
