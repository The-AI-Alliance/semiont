/**
 * Failure classification: a deterministic failure is not retried.
 *
 * A retried deterministic failure always costs exactly double: the second
 * attempt of the same request cannot succeed. The rule is one-sided —
 * only KNOWN-deterministic failures skip the retry budget; everything
 * unrecognized stays retryable (`undefined`), because mis-classifying a
 * transient failure as deterministic silently halves reliability, while the
 * reverse merely costs one wasted attempt.
 *
 * Classification happens HERE, in the worker, where errors are still typed —
 * at the gateway's `job:fail` handler the failure is already a flattened
 * string, and message-regex classification is the drift this module exists
 * to avoid. The class rides the `job:fail` payload; the dispatcher's queue consumes it.
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
 * The taxonomy. It reads the failures the worker and its inference drivers
 * declare, the language's abort, and a status; never the name a provider's
 * library gives a failure. specs/src/worker/failure-class-cases.json states
 * it, and failure-class-cases.test.ts runs every case.
 *
 * - A status, carried as a number: a driver's `ProviderStatusError` carries
 *   the one its provider refused a generation with, and http-transport's
 *   `APIError` the one a gateway refused with. WHICH statuses are
 *   worth another attempt is not decided here: it is `RETRY_RULES.job`, core's
 *   named rule. Restating its conditions here would be a second opinion on a
 *   question core already answers, and where a bare list and a reasoned rule
 *   disagree, the list wins silently. The rule carries the reasoning; this file
 *   carries the ONE thing the rule cannot know: that anything else at or above
 *   400 is a rejected request, and re-sending it unchanged is guaranteed waste →
 *   deterministic.
 * - An abort (`AbortError`, which a driver reports its library's abort as)
 *   is our own bound or shutdown tearing the transport down — nothing was
 *   judged → transient.
 * - A connection that ended and a network failure carry no status, whatever
 *   reported them, and neither does a discovery that failed. All land
 *   `undefined` → retryable, the safe default.
 * - `@semiont/inference`'s `StructuredReadError` carries the stop reason
 *   because the cause classifies differently: `max_tokens` is truncation of
 *   an over-demanded answer — the adapter throws before the caller's
 *   `assertNotTruncated` can see the stop reason, so the classification
 *   must happen on the typed error itself — while any other reason is model
 *   misbehavior a retry may fix.
 */
export function classifyFailure(error: unknown): FailureClass | undefined {
  if (error instanceof DeterministicJobError) return 'deterministic';
  if (error instanceof InferenceTimeoutError) return 'transient';
  if (error instanceof StructuredReadError && error.stopReason === 'max_tokens') return 'deterministic';
  // A `StructuredReadError` with any OTHER stop reason falls through to
  // `undefined` — retryable, and DECIDED rather than defaulted.
  //
  // It only reaches here having exhausted `MAX_SUBDIVISION_DEPTH`, so
  // `subdividable()` has already argued the opposite: at
  // `DETECTION_TEMPERATURE` 0 the identical call returns the identical failure.
  // That argument would be decisive if chunk boundaries were fixed up front.
  // They are not: a resumed unit seeds its chunk size from the checkpoint and
  // then takes one shrink step, so the retry re-cuts the poison piece at a
  // DIFFERENT size and can genuinely come out differently. Being wrong costs
  // one chunk, not the whole prefix.
  //
  // It stays `undefined` rather than becoming `'transient'` on purpose. The wire
  // vocabulary has two values, and this is neither: it is not weather, it is
  // "retryable because the next attempt reads different input". Claiming
  // `transient` would assert an environmental cause nobody established, and
  // absent already means exactly what is true — unrecognised, so retryable.
  if (!isObject(error)) return undefined;

  const name = isString(error.name) ? error.name : '';
  if (name === 'DeterministicJobError') return 'deterministic';
  if (name === 'AbortError') return 'transient';

  const status = isNumber(error.status) ? error.status : undefined;
  if (status !== undefined) {
    if (RETRY_RULES.job.retryable({ status })) return 'transient';
    if (status >= 400) return 'deterministic';
  }

  return undefined;
}
