/**
 * JOB-RESTART-SAFETY P3 — annotation identity is content-addressed.
 *
 * Every recovery path in this plan re-runs work that may already have
 * persisted: the janitor re-queues an orphaned job, a checkpoint resumes a
 * partially-completed unit, a retry repeats a failed one. While ids were
 * `nanoid(21)` each of those minted duplicates — the ~1,516-annotation near-miss
 * in P1's log, and the hand-built `TYPES` list that worked around it.
 *
 * HD1 chose content-addressing over emission-time skip-if-equivalent because
 * the latter is circular with P6: a read-before-write consults the projection,
 * and P6 exists precisely because that sink can be down. So it fails exactly
 * when idempotency matters most.
 *
 * The identity contract: two annotations are the same annotation iff they say
 * the same thing about the same span of the same resource. Anything that would
 * make them legitimately distinct must be an input; anything about WHEN or
 * BY WHOM they were emitted must not be, or recovery stops deduplicating.
 */

import { describe, it, expect } from 'vitest';
import { annotationIdFor } from '../identifier-utils';

const base = {
  resourceId: 'res-1',
  motivation: 'commenting',
  anchor: 'text:10-20',
  body: [{ type: 'TextualBody', value: 'a remark', purpose: 'commenting' }],
};

describe('annotationIdFor — content-addressed annotation identity', () => {
  it('is deterministic across calls', () => {
    expect(annotationIdFor(base)).toBe(annotationIdFor(base));
  });

  it('is stable across key order in the body', () => {
    // The body is built by different code paths for different motivations; if
    // the hash depended on property order, the same annotation would get two
    // ids depending on which builder produced it.
    const reordered = { ...base, body: [{ purpose: 'commenting', value: 'a remark', type: 'TextualBody' }] };
    expect(annotationIdFor(reordered)).toBe(annotationIdFor(base));
  });

  // ── what must make two annotations DIFFERENT ──────────────────────────

  it('distinguishes different resources', () => {
    expect(annotationIdFor({ ...base, resourceId: 'res-2' })).not.toBe(annotationIdFor(base));
  });

  it('distinguishes different spans', () => {
    expect(annotationIdFor({ ...base, anchor: 'text:11-21' })).not.toBe(annotationIdFor(base));
  });

  it('distinguishes different motivations on the same span', () => {
    expect(annotationIdFor({ ...base, motivation: 'assessing' })).not.toBe(annotationIdFor(base));
  });

  it('distinguishes different bodies on the same span — the collision HD1 named', () => {
    // Two comments on one span are two annotations. Hashing without the body
    // would silently collapse them into one.
    const other = { ...base, body: [{ type: 'TextualBody', value: 'a DIFFERENT remark', purpose: 'commenting' }] };
    expect(annotationIdFor(other)).not.toBe(annotationIdFor(base));
  });

  it('distinguishes a bodiless annotation from one with a body', () => {
    const { body: _body, ...bodiless } = base;
    expect(annotationIdFor(bodiless)).not.toBe(annotationIdFor(base));
  });

  // ── what must NOT ─────────────────────────────────────────────────────

  it('ignores everything not passed to it — no clock, no counter, no randomness', () => {
    // Stated as a property rather than an inspection: the function takes only
    // the identity inputs, so `created` and the emitting agent cannot leak in.
    // A re-emission during recovery happens at a different time, by a
    // different worker process, and must still collide.
    const ids = new Set(Array.from({ length: 50 }, () => annotationIdFor(base)));
    expect(ids.size).toBe(1);
  });

  // ── shape, inherited from the nanoid contract this replaces ───────────
  //
  // `identifier-utils.test.ts` is deleted rather than adapted: its central
  // case asserted that two calls produce DIFFERENT ids, which is precisely the
  // contract P3 reverses. Its two surviving assertions live here.

  it('produces a URL-safe id — it lands in an annotation URI path segment', () => {
    expect(annotationIdFor(base)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is a BARE id of the same length nanoid(21) produced', () => {
    // Same length so nothing downstream that sized a column or a URI around it
    // changes; bare so it cannot be mistaken for the URI it gets embedded in.
    const id = annotationIdFor(base);
    expect(id.length).toBe(21);
    expect(id).not.toContain('://');
    expect(id).not.toContain('/annotations/');
  });
});
