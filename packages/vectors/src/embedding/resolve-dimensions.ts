/**
 * Resolving a collection's vector width against a provider that may not be ready.
 *
 * The width is discovered by embedding a probe (the model is the authority — a
 * hand-maintained table goes stale the day a new model ships), so creating a
 * collection is the one boot step that needs the embedding provider to be live.
 * On the first boot of a fresh KB that races Ollama's model pull, and losing it
 * must not be fatal: unretried, it costs archivist, librarian and smelter 3, 4
 * and 5 restarts (measured), and the archivist's flapping separately strands
 * `semiont-worker` in `Created` forever. So the probe is retried under
 * `EMBEDDING_PROVIDER_RETRY`.
 *
 * Called only where a collection must be CREATED. A warm KB short-circuits before
 * reaching here and contacts no provider at boot, so this adds no steady-state
 * latency.
 */

import { retryWithBackoff, isTransientFetchError, type RetryPolicy } from '@semiont/core';
import { isColdModelError } from './provider-error';

/**
 * How long a boot waits for the embedding provider to become usable.
 *
 * **Not `STARTUP_FETCH_RETRY`.** That policy answers *"how long does a boot
 * wait for a peer to start listening?"* — seconds. This answers *"how long does
 * a boot wait for a model to download?"* — measured at "under a minute", and
 * `STARTUP_FETCH_RETRY`'s ~39s ceiling (≈29s expected, once jittered) would
 * expire just before the thing it is waiting for arrives.
 *
 * Two facts that happen to be measured in seconds are still two facts. One
 * constant is right when it is one fact; sharing it here would mean every future
 * adjustment to the gateway's patience silently moved this one.
 *
 * Worst case ≈ `retryBudgetMs(EMBEDDING_PROVIDER_RETRY, EMBED_ROUND_TRIP_TIMEOUT_MS)` — see
 * `startup-timeout.test.ts`, which gates it against the deadline it could race.
 */
export const EMBEDDING_PROVIDER_RETRY: RetryPolicy = {
  attempts: 12,
  initialDelayMs: 1_000,
  maxDelayMs: 15_000,
};

/**
 * Not ready YET, by either route: the model is still downloading (404), or the
 * provider is not listening at all (connection refused).
 *
 * Composed rather than choosing one, because at boot they are the same wait with
 * the same collateral — a flapping archivist strands `semiont-worker` in
 * `Created` whichever error caused the flap. Retrying connection-refused to the
 * GATEWAY and not to Ollama, in the same three mains, would be an asymmetry
 * nobody chose; `authenticate()` retries on `isTransientFetchError` at boot.
 */
const notReady = (error: unknown): boolean =>
  isColdModelError(error) || isTransientFetchError(error);

export async function resolveDimensions(
  dimensions: () => Promise<number>,
  /** The caller's boot deadline, if it has one. Stops the retry when it fires,
   *  so a caller racing a timeout against this cannot cut it short by surprise. */
  signal?: AbortSignal,
): Promise<number> {
  try {
    return await retryWithBackoff(dimensions, notReady, EMBEDDING_PROVIDER_RETRY, undefined, signal);
  } catch (error) {
    // `isColdModelError`, NOT `instanceof EmbeddingProviderError`: a 401 is also
    // one of those, and the wider check lets a bad API key fall through to the
    // "still unavailable" message instead of rethrowing. It is a type guard, so
    // `error.model` narrows without a second test.
    // Connection-level failures propagate with their own message — "fetch
    // failed" against a host that never answered needs no help being read, and
    // dressing it up as a model problem would misdirect.
    if (!isColdModelError(error)) throw error;
    // Both possibilities are live and one 404 does not distinguish them. A
    // message implying only the first sends a reader watching for a pull
    // that will never finish because the name is wrong.
    //
    // The model comes off the error as a FIELD. It is not threaded down through
    // `QdrantConfig` and `VectorStoreConfig` (three layers of plumbing for a
    // string) and it is not read back out of the provider's body — the throw site
    // knows it, so it travels with the failure. Reading it out of prose would be
    // the substring-matching the typed error exists to end, and it would only
    // work for Ollama: Voyage's 404 body does not name the model.
    throw new Error(
      `Embedding model '${error.model}' is still unavailable on ${error.provider} after ` +
        `${EMBEDDING_PROVIDER_RETRY.attempts} attempts. Either it has not been pulled, or the ` +
        `configured model name is wrong — the provider answers 404 for both.`,
      { cause: error },
    );
  }
}
