/**
 * Failure classification — ABANDONED-INFERENCE P3 (A4, HD2).
 *
 * A retried deterministic failure always costs exactly double: the second
 * attempt of the same request cannot succeed. HD2's ruling is one-sided —
 * only KNOWN-deterministic failures skip the retry budget; everything
 * unrecognized stays retryable (`undefined`), because mis-classifying a
 * transient failure as deterministic silently halves reliability, while the
 * reverse merely costs one wasted attempt (today's behavior).
 *
 * Classification happens HERE, in the worker, where errors are still typed —
 * at the gateway's `job:fail` handler the failure is already a flattened
 * string, and message-regex classification is the drift this module exists
 * to avoid. The class rides the `job:fail` payload; `failJob` consumes it.
 */

import { isNumber, isObject, isString } from '@semiont/core';
import { StructuredReadError } from '@semiont/inference';
import { InferenceTimeoutError } from './workers/inference-call';

export type FailureClass = 'transient' | 'deterministic';

/**
 * Marker for failures WE know cannot succeed on a second identical attempt —
 * thrown at the sites that judge the work itself rather than the transport:
 * response truncation despite the derived budget, a media type with nothing
 * to extract. Throw it instead of `Error` wherever that knowledge exists.
 */
export class DeterministicJobError extends Error {
  // Typed string, not the literal: subclasses (YieldCollapseError) carry
  // their own name — classification is instanceof, never name-matching.
  override readonly name: string = 'DeterministicJobError';
}

/**
 * The taxonomy, and its provider coupling — THE part that will drift:
 *
 * - `@anthropic-ai/sdk` errors carry a numeric `status`. 408/429/5xx are
 *   environmental (throttles, overload, gateway weather) → transient. The
 *   remaining 4xx mean the request itself was rejected — invalid, too
 *   large, unauthorized — and re-sending it unchanged is guaranteed waste
 *   → deterministic.
 * - Aborts (`APIUserAbortError` from the SDK, `AbortError` from fetch/mock)
 *   are our own bound or shutdown tearing the transport down — nothing was
 *   judged → transient.
 * - Ollama surfaces plain `Error`s (no status) and network failures as
 *   `TypeError: fetch failed`; the SDK's `MessageStream terminated` is a
 *   dropped connection. All land `undefined` → retryable, the safe default.
 * - `@semiont/inference`'s `StructuredReadError` carries the stop reason
 *   because the cause classifies differently: `max_tokens` is truncation of
 *   an over-demanded answer — the adapter throws before the caller's
 *   `assertNotTruncated` can see the stop reason, so the classification
 *   must happen on the typed error itself (measured live 2026-09-02) —
 *   while any other reason is model misbehavior a retry may fix.
 */
export function classifyFailure(error: unknown): FailureClass | undefined {
  if (error instanceof DeterministicJobError) return 'deterministic';
  if (error instanceof InferenceTimeoutError) return 'transient';
  if (error instanceof StructuredReadError && error.stopReason === 'max_tokens') return 'deterministic';
  if (!isObject(error)) return undefined;

  const name = isString(error.name) ? error.name : '';
  if (name === 'DeterministicJobError') return 'deterministic';
  if (name === 'APIUserAbortError' || name === 'AbortError') return 'transient';

  const status = isNumber(error.status) ? error.status : undefined;
  if (status !== undefined) {
    if (status === 408 || status === 429 || status >= 500) return 'transient';
    if (status >= 400) return 'deterministic';
  }

  return undefined;
}
