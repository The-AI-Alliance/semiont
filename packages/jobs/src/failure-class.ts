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

import { isNumber, isObject, isString, RETRY_RULES, type components } from '@semiont/core';
import { StructuredReadError } from '@semiont/inference';
import { InferenceTimeoutError } from './workers/inference-call';

/** Derived from the spec, not restated: the wire owns this vocabulary
 *  (`FailureClass.json`, referenced by job:fail and job:failed alike). */
export type FailureClass = components['schemas']['FailureClass'];

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
 * - `@anthropic-ai/sdk` errors carry a numeric `status`, and WHICH statuses are
 *   worth another attempt is not decided here: it is `RETRY_RULES.job`
 *   (RETRY-CLASSIFICATION P2). This file used to restate the same three
 *   conditions, which made it a second opinion on a question core already
 *   answered — and the census that found it showed that where a bare list and a
 *   reasoned rule disagree, the list wins silently. The rule carries the
 *   reasoning; this file carries the ONE thing the rule cannot know: that
 *   anything else at or above 400 is a rejected request, and re-sending it
 *   unchanged is guaranteed waste → deterministic.
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
  // A `StructuredReadError` with any OTHER stop reason falls through to
  // `undefined` — retryable, and DECIDED rather than defaulted
  // (RETRY-CLASSIFICATION P2, 2026-09-12).
  //
  // It only reaches here having exhausted `MAX_SUBDIVISION_DEPTH`, so
  // `subdividable()` has already argued the opposite: at
  // `DETECTION_TEMPERATURE` 0 the identical call returns the identical failure.
  // That argument was decisive while chunk boundaries were fixed up front. It is
  // not any more — CHUNK-GRAIN-RESUME HD2 (option C) seeds a resumed unit's size
  // from the checkpoint and then takes one shrink step, so the retry re-cuts the
  // poison piece at a DIFFERENT size and can genuinely come out differently. The
  // price of being wrong fell with it: one chunk, not the whole prefix.
  //
  // It stays `undefined` rather than becoming `'transient'` on purpose. The wire
  // vocabulary has two values, and this is neither: it is not weather, it is
  // "retryable because the next attempt reads different input". Claiming
  // `transient` would assert an environmental cause nobody established, and
  // absent already means exactly what is true — unrecognised, so retryable.
  if (!isObject(error)) return undefined;

  const name = isString(error.name) ? error.name : '';
  if (name === 'DeterministicJobError') return 'deterministic';
  if (name === 'APIUserAbortError' || name === 'AbortError') return 'transient';

  const status = isNumber(error.status) ? error.status : undefined;
  if (status !== undefined) {
    if (RETRY_RULES.job.retryable({ status })) return 'transient';
    if (status >= 400) return 'deterministic';
  }

  return undefined;
}
