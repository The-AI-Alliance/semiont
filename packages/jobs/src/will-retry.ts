import type { JobMetadata } from './types';

/**
 * Will this failure be re-queued for another attempt?
 *
 * ONE decision site, deliberately (JOB-RESTART-SAFETY P5). Two places need
 * the answer and they must never disagree:
 *
 *  - the dispatcher's queue acts on it — re-queue or write the terminal
 *    record (apps/dispatcher/handlers, `will_retry_after`);
 *  - the worker reports it on `job:fail` as `willRetry`, so a client's
 *    job-watch stream knows whether the failure it just saw is the end.
 *
 * Two implementations, TypeScript here and Rust in the dispatcher, are held to
 * one answer by specs/src/jobs/retry-cases.json, which both run. A
 * disagreement would be the classic N-places-decide-one-thing bug: the
 * client would end a stream the queue then revived, or hold a stream open on
 * a job nobody will run again. The worker reads the budget off
 * the record it claimed, and `retryCount` only changes when the dispatcher
 * fails the attempt, so the two evaluations see the same numbers.
 *
 * A known-deterministic failure skips the budget outright — the same request
 * cannot succeed on a second attempt, so a retry is guaranteed waste at full
 * price. Unclassified failures are treated as transient.
 */
export function willRetryAfter(
  metadata: Pick<JobMetadata, 'retryCount' | 'maxRetries'>,
  failureClass?: 'transient' | 'deterministic',
): boolean {
  return failureClass !== 'deterministic' && metadata.retryCount < metadata.maxRetries;
}
