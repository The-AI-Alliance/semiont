/**
 * Resolving a collection's vector width against a provider that may not be ready.
 *
 * The width is discovered by embedding a probe (the model is the authority — a
 * hand-maintained table goes stale the day a new model ships), so creating a
 * collection is the one boot step that needs the embedding provider to be live.
 * On the first boot of a fresh KB that races Ollama's model pull, and losing it
 * used to be `Fatal`: measured 3, 4 and 5 restarts for archivist, librarian and
 * smelter, with the archivist's flapping separately stranding `semiont-worker`
 * in `Created` forever.
 *
 * Reuses `STARTUP_FETCH_RETRY` **by name** — one place decides how long a boot
 * waits for a dependency, rather than a second startup-retry constant that drifts
 * from it.
 *
 * Called only where a collection must be CREATED. A warm KB short-circuits before
 * reaching here and contacts no provider at boot, so this adds no steady-state
 * latency.
 */

import { retryWithBackoff, STARTUP_FETCH_RETRY } from '@semiont/core';
import { isColdModelError } from './provider-error';

export async function resolveDimensions(dimensions: () => Promise<number>): Promise<number> {
  try {
    return await retryWithBackoff(dimensions, isColdModelError, STARTUP_FETCH_RETRY);
  } catch (error) {
    // `isColdModelError`, NOT `instanceof EmbeddingProviderError`: a 401 is also
    // one of those, and swapping the check let a bad API key fall through to the
    // "still unavailable" message instead of rethrowing. It is a type guard, so
    // `error.model` narrows without a second test.
    if (!isColdModelError(error)) throw error;
    // Both possibilities are live and one 404 does not distinguish them. The old
    // message implied only the first, which sends a reader watching for a pull
    // that will never finish because the name is wrong.
    //
    // The model comes off the error as a FIELD. It is not threaded down through
    // `QdrantConfig` and `VectorStoreConfig` (three layers of plumbing for a
    // string) and it is not read back out of the provider's body — the throw site
    // knows it, so it travels with the failure. Reading it out of prose would be
    // the substring-matching this whole fix exists to end, and it would only work
    // for Ollama: Voyage's 404 body does not name the model.
    throw new Error(
      `Embedding model '${error.model}' is still unavailable on ${error.provider} after ` +
        `${STARTUP_FETCH_RETRY.attempts} attempts. Either it has not been pulled, or the ` +
        `configured model name is wrong — the provider answers 404 for both.`,
      { cause: error },
    );
  }
}
