/**
 * The retry predicate against the shared case table,
 * specs/src/jobs/retry-cases.json.
 *
 * Two consumers must never disagree about whether a failure is the end: the
 * queue ACTS on the answer (re-queue vs terminal record), and the worker
 * REPORTS it on `job:fail` as `willRetry`, which is what lets a client's
 * job-watch stream stay alive across a retry. Every implementation runs the
 * same table, so a second implementation cannot drift from this one unseen.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { willRetryAfter } from '../will-retry';

interface RetryCase {
  why: string;
  retryCount: number;
  maxRetries: number;
  failureClass?: 'transient' | 'deterministic';
  retries: boolean;
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../specs/src/jobs/retry-cases.json');
const { cases } = JSON.parse(readFileSync(TABLE, 'utf8')) as { cases: RetryCase[] };

describe('willRetryAfter', () => {
  it('has cases to run', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.why, c] as const))('%s', (_why, c) => {
    expect(willRetryAfter({ retryCount: c.retryCount, maxRetries: c.maxRetries }, c.failureClass)).toBe(c.retries);
  });
});
