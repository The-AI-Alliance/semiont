/**
 * An embedding provider's HTTP failure, carrying the status it came from.
 *
 * Both providers used to throw `new Error(\`… error ${status}: ${body}\`)`, which
 * put the status in the text and nowhere else — so no caller could branch on it
 * without matching a substring. That is the mirror this codebase refuses
 * elsewhere, and it is why a cold model cache was unclassifiable and therefore
 * fatal on every first boot of a fresh KB.
 *
 * One class for both providers so they agree by construction rather than by two
 * people remembering the same shape.
 */

export type EmbeddingProviderName = 'ollama' | 'voyage';

export class EmbeddingProviderError extends Error {
  readonly provider: EmbeddingProviderName;
  readonly status: number;
  /** The model that was asked for — the throw site knows it, so it travels as a
   *  field. A consumer needing it must never have to read it out of `body`:
   *  that is the substring-matching this class exists to end, and Ollama's body
   *  happens to name the model while Voyage's does not. */
  readonly model: string;
  readonly body: string;

  constructor(provider: EmbeddingProviderName, status: number, model: string, body: string) {
    // The message keeps its old shape — status included — so existing log lines
    // and anything matching on them read exactly as before. The fields are what
    // is new; the prose is not a step backwards.
    super(`${provider} embed error ${status}: ${body}`);
    this.name = 'EmbeddingProviderError';
    this.provider = provider;
    this.status = status;
    this.model = model;
    this.body = body;
  }
}

/**
 * True when the model has not been pulled YET.
 *
 * The case `isTransientFetchError` did not anticipate, and deliberately does not
 * cover: its exclusion of HTTP-level failures is right for a gateway 401 — "the
 * server is UP and rejected us; retrying won't change its mind" — and wrong here.
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
 * both are a 404 and the provider says nothing more. That is accepted: a typo now
 * fails after the retry budget instead of instantly, which is why the message on
 * exhaustion must name both possibilities.
 */
export function isColdModelError(error: unknown): error is EmbeddingProviderError {
  return error instanceof EmbeddingProviderError && error.status === 404;
}
