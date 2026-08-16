/**
 * Type-level guards for the job-result wire shapes —
 * WIRE-UNION-DISCRIMINANTS P1 (A1); P2's narrowing tests land here too.
 *
 * A1: `JobGenerationResult.resourceId` is REQUIRED. The worker awaits the
 * create round-trip (`yield.resource(...)`) and holds the id before it ever
 * emits `job:complete` — the id is always on the wire. The schema previously
 * claimed the opposite (optional, "populated by Stower"), and that lie
 * propagated: an SDK consumer designed around "the id may be missing," and
 * the launcher grew a `!= nil` pointer dance. Enforced by `tsc --noEmit`.
 */
import { describe, it, expect } from 'vitest';
import type { components } from '../types';

type JobGenerationResult = components['schemas']['JobGenerationResult'];

describe('JobGenerationResult — the id is always there (A1)', () => {
  it('a result with both fields is the wire shape', () => {
    const full: JobGenerationResult = { resourceId: 'res-1', resourceName: 'Ouranos' };
    expect(full.resourceId).toBe('res-1');
  });

  it('a result missing resourceId does not typecheck', () => {
    // @ts-expect-error — resourceId is required: the worker always sends it
    const missing: JobGenerationResult = { resourceName: 'Ouranos' };
    expect(missing).toBeDefined();
  });
});
