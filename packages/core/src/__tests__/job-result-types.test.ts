/**
 * Type-level guards for what a job is asked with and what it reports, held by
 * `tsc --noEmit`.
 *
 * A1: `JobGenerationResult.resourceId` is REQUIRED. The worker awaits the
 * create round-trip (`yield.resource(...)`) and holds the id before it ever
 * emits `job:complete` — the id is always on the wire. A schema claiming the
 * opposite (optional) propagates: an SDK consumer designs around "the id may
 * be missing," and the launcher grows a `!= nil` pointer dance.
 *
 * A2: a result has no discriminant of its own. Which job it answers is said by
 * the job description beside it, and the three results are told apart by what
 * each alone carries: `declined`; the resource a `yield` job made; the counts
 * of a `mark` job. No member is shared, so the narrowing below needs no cast
 * and leaves nothing unhandled.
 *
 * A3: a `mark` job reports one shape whatever its motivation: `found` and
 * `persisted`, never a count named for the motivation.
 *
 * A4: `jobType` is the verb, and a job description is its `jobType` and enough
 * parameters to be well formed: a `mark` job names its resource and its
 * motivation and takes only what that motivation takes; a `yield` job names no
 * resource, because its context's focus does.
 *
 * A5: a claim's entries are partial job descriptions, and a `mark` entry
 * always states its motivation.
 */
import { describe, it, expect } from 'vitest';
import type { components } from '../types';
import { resourceId } from '../identifiers';

type JobGenerationResult = components['schemas']['JobGenerationResult'];

describe('JobGenerationResult — the id is always there (A1)', () => {
  it('a result with every field is the wire shape', () => {
    const full: JobGenerationResult = { resourceId: resourceId('res-1'), resourceName: 'Ouranos', truncated: false };
    expect(full.resourceId).toBe('res-1');
  });

  it('a result missing resourceId does not typecheck', () => {
    // @ts-expect-error — resourceId is required: the worker always sends it
    const missing: JobGenerationResult = { resourceName: 'Ouranos', truncated: false };
    expect(missing).toBeDefined();
  });
});

type JobResult = components['schemas']['JobResult'];

function describeResult(r: JobResult): string {
  if ('declined' in r) return r.reason;
  if ('resourceId' in r) return `${r.resourceName} → ${r.resourceId}`;
  return `${r.persisted}/${r.found}`;
}

describe('JobResult — told apart by its own members, with no `kind` (A2, A3)', () => {
  it('narrows every member, castless', () => {
    expect(describeResult({ resourceId: resourceId('res-1'), resourceName: 'Ouranos', truncated: false })).toBe('Ouranos → res-1');
    expect(describeResult({ found: 4, persisted: 3, errors: 1 })).toBe('3/4');
    expect(describeResult({ found: 3, persisted: 3, byCategory: { Issue: 3 } })).toBe('3/3');
    expect(describeResult({ declined: true, reason: 'encrypted' })).toBe('encrypted');
  });

  it('a result that states a `kind` does not typecheck', () => {
    // @ts-expect-error — the job description beside a result says which job it answers
    const tagged: JobResult = { kind: 'highlight-annotation', found: 2, persisted: 2 };
    expect(tagged).toBeDefined();
  });

  it('a count named for a motivation does not typecheck', () => {
    // @ts-expect-error — one shape for every motivation: `found`, `persisted`
    const prefixed: JobResult = { highlightsFound: 2, highlightsCreated: 2 };
    expect(prefixed).toBeDefined();
  });
});

type JobType = components['schemas']['JobType'];
type JobCreateCommand = components['schemas']['JobCreateCommand'];
type GenerationJobParams = components['schemas']['GenerationJobParams'];

const R = resourceId('res-1');
const generation: GenerationJobParams = {
  title: 'Ouranos',
  storageUri: 'file://generated/ouranos.md',
  context: {
    focus: { kind: 'resource', resource: { '@context': 'https://semiont.dev/context/v1', '@id': R, name: 'Source', representations: [] } },
    graph: { nodes: [], edges: [] },
    metadata: {},
  },
};

describe('a job description is its jobType and enough parameters (A4)', () => {
  it('jobType is the verb', () => {
    const verbs: JobType[] = ['mark', 'yield'];
    expect(verbs).toHaveLength(2);
    // @ts-expect-error — the six names made from a motivation are gone
    const old: JobType = 'highlight-annotation';
    expect(old).toBeDefined();
  });

  it('a mark job names its resource and its motivation', () => {
    const highlight: JobCreateCommand = { jobType: 'mark', resourceId: R, params: { motivation: 'highlighting', density: 3 } };
    const tag: JobCreateCommand = { jobType: 'mark', resourceId: R, params: { motivation: 'tagging', schemaId: 'irac', categories: ['Issue'] } };
    expect([highlight.jobType, tag.jobType]).toEqual(['mark', 'mark']);

    // @ts-expect-error — a mark job is about a resource
    const nowhere: JobCreateCommand = { jobType: 'mark', params: { motivation: 'highlighting' } };
    // @ts-expect-error — a mark job has a motivation
    const aimless: JobCreateCommand = { jobType: 'mark', resourceId: R, params: {} };
    expect([nowhere, aimless]).toHaveLength(2);
  });

  it('a job takes only what its motivation takes', () => {
    // @ts-expect-error — a highlight has no tone
    const toned: JobCreateCommand = { jobType: 'mark', resourceId: R, params: { motivation: 'highlighting', tone: 'scholarly' } };
    // @ts-expect-error — a link job takes no instructions
    const instructed: JobCreateCommand = { jobType: 'mark', resourceId: R, params: { motivation: 'linking', entityTypes: ['Person'], instructions: 'find relationships' } };
    // @ts-expect-error — a tag job names its schema and its categories
    const schemaless: JobCreateCommand = { jobType: 'mark', resourceId: R, params: { motivation: 'tagging' } };
    expect([toned, instructed, schemaless]).toHaveLength(3);
  });

  it('a yield job names no resource: its context does', () => {
    const made: JobCreateCommand = { jobType: 'yield', params: generation };
    expect(made.jobType).toBe('yield');
    // @ts-expect-error — the context's focus is the resource
    const twice: JobCreateCommand = { jobType: 'yield', resourceId: R, params: generation };
    expect(twice).toBeDefined();
  });
});

type JobClaimCommand = components['schemas']['JobClaimCommand'];

describe('a claim names fields of the job description (A5)', () => {
  it('each entry is a partial description', () => {
    const claim: JobClaimCommand = { accepts: [{ jobType: 'mark', params: { motivation: 'tagging' } }, { jobType: 'yield' }] };
    expect(claim.accepts).toHaveLength(2);
  });

  it('a mark entry without its motivation does not typecheck', () => {
    // @ts-expect-error — a mark claim always has its motivation
    const any: JobClaimCommand = { accepts: [{ jobType: 'mark' }] };
    expect(any).toBeDefined();
  });
});
