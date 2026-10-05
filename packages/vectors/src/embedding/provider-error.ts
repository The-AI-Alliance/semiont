/**
 * An embedding provider's HTTP failure, carrying the status it came from.
 *
 * A plain `new Error(\`… error ${status}: ${body}\`)` would put the status in
 * the text and nowhere else — so no caller could branch on it without matching
 * a substring, and a cold model cache would be unclassifiable and therefore
 * fatal on every first boot of a fresh KB.
 *
 * One class for both providers so they agree by construction rather than by two
 * people remembering the same shape.
 */

export type EmbeddingProviderName = 'ollama' | 'voyage';

/**
 * Deadline on ONE embedding request — one round trip, never a whole batch.
 *
 * Named for the round trip so it cannot drift into bounding a batch: applied
 * to a resource's entire chunk set sent as a single request, this number
 * would silently bound a whole book.
 *
 * Without it a retry budget is a count with no wall clock: delays are bounded by
 * the policy, but a `fetch` with no signal can sit in TCP retransmit for minutes
 * under loss, so N attempts × unbounded is unbounded. `/bus/emit` follows the
 * same rule — the caller's deadline governs one attempt, the policy governs the set.
 *
 * 15s rather than something tighter because Ollama can spend real time LOADING a
 * model into memory on the first embed after a pull lands. That is a success in
 * progress, and a 5s deadline would abort it just as it was about to work.
 */
export const EMBED_ROUND_TRIP_TIMEOUT_MS = 15_000;

export class EmbeddingProviderError extends Error {
  readonly provider: EmbeddingProviderName;
  readonly status: number;
  /** The model that was asked for — the throw site knows it, so it travels as a
   *  field. A consumer needing it must never have to read it out of `body`:
   *  that is the substring-matching this class exists to end, and Ollama's body
   *  happens to name the model while Voyage's does not. */
  readonly model: string;
  readonly body: string;
  /** Which slice of a batch failed, when the failure came from a sliced batch.
   *  An object rather than two more positional numbers: adjacent same-typed
   *  parameters are how a caller silently passes the wrong thing. */
  readonly slice?: { index: number; start: number; end: number };

  constructor(
    provider: EmbeddingProviderName,
    status: number,
    model: string,
    body: string,
    slice?: { index: number; start: number; end: number },
  ) {
    // The status is in the message as well as on the fields, so a log line
    // reads on its own; callers branch on the fields.
    super(
      slice
        ? `${provider} embed error ${status} (slice ${slice.index}, texts ${slice.start}–${slice.end}): ${body}`
        : `${provider} embed error ${status}: ${body}`,
    );
    this.name = 'EmbeddingProviderError';
    this.provider = provider;
    this.status = status;
    this.model = model;
    this.body = body;
    if (slice) this.slice = slice;
  }
}

/**
 * True when the model has not been pulled YET.
 *
 * The case `isTransientFetchError` deliberately does not cover: its exclusion
 * of HTTP-level failures is right for a gateway 401 — "the server is UP and
 * rejected us; retrying won't change its mind" — and wrong here.
 * A cold-cache 404 means the server is up, the *resource* is not there yet, and
 * it will be. Do not widen `isTransientFetchError` to reach this; its narrowness
 * is load-bearing for the reasoning it already carries.
 *
 * Narrow on two axes, both on purpose:
 *  - **only 404.** A 401 is a bad key, a 400 a bad request; neither becomes a 200
 *    by waiting. 429/503 from a provider under load are arguably retryable too,
 *    but nothing has observed them here and a predicate should not speculate.
 *  - **only this error type.** A 404 from the gateway means not-found, and
 *    retrying that is wrong. Structure, not a bare status, is what distinguishes
 *    "not yet" from "not there".
 *
 * It cannot tell "not pulled yet" from "the configured model name is wrong" —
 * both are a 404 and the provider says nothing more. That is accepted: a typo
 * fails after the retry budget instead of instantly, which is why the message on
 * exhaustion must name both possibilities.
 */
export function isColdModelError(error: unknown): error is EmbeddingProviderError {
  return error instanceof EmbeddingProviderError && error.status === 404;
}
