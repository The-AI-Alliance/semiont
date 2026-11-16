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
    const full: JobGenerationResult = { kind: 'generation', resourceId: 'res-1', resourceName: 'Ouranos', truncated: false };
    expect(full.resourceId).toBe('res-1');
  });

  it('a result missing resourceId does not typecheck', () => {
    // @ts-expect-error — resourceId is required: the worker always sends it
    const missing: JobGenerationResult = { resourceName: 'Ouranos' };
    expect(missing).toBeDefined();
  });
});

type JobResult = components['schemas']['JobResult'];

/**
 * A2 + A3 (WIRE-UNION-DISCRIMINANTS P2): every member of the union carries
 * the same single-valued discriminant, so a consumer narrows WITHOUT a type
 * assertion, and an unhandled member is a compile error (the `never`-default
 * idiom `assistProgressCopy` established for `JobProgressMessage.code`).
 */
function describeResult(r: JobResult): string {
  switch (r.kind) {
    case 'generation':
      return `${r.resourceName} → ${r.resourceId}`;
    case 'reference-annotation':
      return `${r.totalEmitted}/${r.totalFound}`;
    case 'highlight-annotation':
      return `${r.highlightsCreated}/${r.highlightsFound}`;
    case 'assessment-annotation':
      return `${r.assessmentsCreated}/${r.assessmentsFound}`;
    case 'comment-annotation':
      return `${r.commentsCreated}/${r.commentsFound}`;
    case 'tag-annotation':
      return `${r.tagsCreated}/${r.tagsFound}`;
    case 'declined':
      return r.reason;
    default: {
      const unhandled: never = r;
      return unhandled;
    }
  }
}

describe('JobResult — the union discriminates (A2, A3)', () => {
  it('narrows every member by kind, castless', () => {
    expect(describeResult({ kind: 'generation', resourceId: 'res-1', resourceName: 'Ouranos', truncated: false })).toBe('Ouranos → res-1');
    expect(describeResult({ kind: 'reference-annotation', totalFound: 4, totalEmitted: 3, errors: 0 })).toBe('3/4');
    expect(describeResult({ kind: 'highlight-annotation', highlightsFound: 2, highlightsCreated: 2 })).toBe('2/2');
    expect(describeResult({ kind: 'assessment-annotation', assessmentsFound: 1, assessmentsCreated: 1 })).toBe('1/1');
    expect(describeResult({ kind: 'comment-annotation', commentsFound: 5, commentsCreated: 4 })).toBe('4/5');
    expect(describeResult({ kind: 'tag-annotation', tagsFound: 3, tagsCreated: 3, byCategory: {} })).toBe('3/3');
    expect(describeResult({ kind: 'declined', declined: true, reason: 'encrypted' })).toBe('encrypted');
  });
});
