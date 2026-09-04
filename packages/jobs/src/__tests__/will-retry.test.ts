/**
 * The retry predicate — JOB-RESTART-SAFETY P5.
 *
 * Two consumers must never disagree about whether a failure is the end:
 * `FsJobQueue.failJob` ACTS on the answer (re-queue vs terminal record), and
 * the worker REPORTS it on `job:fail` as `willRetry`, which is what lets a
 * client's job-watch stream stay alive across a retry. A second copy of this
 * rule is how the two come to disagree, so it lives in one place and both
 * import it.
 */

import { describe, it, expect } from 'vitest';
import { willRetryAfter } from '../will-retry';

const budget = (retryCount: number, maxRetries: number) => ({ retryCount, maxRetries });

describe('willRetryAfter', () => {
  it('retries a transient failure with budget left', () => {
    expect(willRetryAfter(budget(0, 1), 'transient')).toBe(true);
  });

  it('treats an unclassified failure as transient', () => {
    expect(willRetryAfter(budget(0, 1), undefined)).toBe(true);
  });

  it('is terminal once the budget is spent', () => {
    expect(willRetryAfter(budget(1, 1), 'transient')).toBe(false);
  });

  it('is terminal for a deterministic failure even with budget left', () => {
    // The same request cannot succeed on a second attempt, so a retry is
    // guaranteed waste at full price.
    expect(willRetryAfter(budget(0, 3), 'deterministic')).toBe(false);
  });

  it('is terminal when no retries were ever budgeted', () => {
    expect(willRetryAfter(budget(0, 0), 'transient')).toBe(false);
  });
});
