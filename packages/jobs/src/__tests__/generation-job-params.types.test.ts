import { describe, it, expect } from 'vitest';
import type { GenerationJobParams, GatheredContext } from '@semiont/core';

/**
 * tsc-enforced contract for the generation params bag — the SHARED wire type
 * (YIELD-FROM-CONTEXT P1), generated from the spec schema and consumed by
 * both the sdk (write side) and the worker (read side).
 *
 * Supersedes the GenerationParams contract file: the all-optional era is
 * over. Requiredness is decided once, in the schema — `title`, `storageUri`,
 * and `context` are the wire's law now, and `{}` no longer compiles (the
 * inverted pin below holds that door shut).
 */

const CONTEXT: GatheredContext = {
  focus: {
    kind: 'resource',
    resource: {
      '@context': 'https://semiont.dev/context/v1',
      '@id': 'res-src',
      name: 'Source',
      representations: [],
    },
  },
  graph: { nodes: [], edges: [] },
  metadata: {},
};

const REQUIRED = {
  title: 'Answer',
  storageUri: 'file://generated/answer.md',
  context: CONTEXT,
} satisfies GenerationJobParams;

describe('GenerationJobParams contract', () => {
  it('the required trio alone is a complete bag — generation is annotation-OPTIONAL', () => {
    const p: GenerationJobParams = REQUIRED;
    expect(p.title).toBe('Answer');
  });

  it('the empty bag no longer compiles — requiredness is the wire\'s law', () => {
    // @ts-expect-error — title, storageUri, and context are required (P1 ended
    // the all-optional era this file used to pin).
    const p: GenerationJobParams = {};
    expect(p).toEqual({});
  });

  it('task and structure accept canonical values AND arbitrary strings', () => {
    // The wire type is `string` — the canonical values live in the schema
    // description and the worker's loud-degrade handling; the sdk's
    // GenerationOptions keeps the autocomplete-friendly literal union.
    const canonical: GenerationJobParams = { ...REQUIRED, task: 'answer', structure: 'prose' };
    const custom: GenerationJobParams = {
      ...REQUIRED,
      task: 'Translate the source into idiomatic French',
      structure: 'a bulleted list of key facts',
    };
    expect(canonical.task).toBe('answer');
    expect(custom.structure).toBe('a bulleted list of key facts');
  });

  it('accepts cite and outputMediaType (INLINE-CITATIONS / media-type gate)', () => {
    const p: GenerationJobParams = { ...REQUIRED, cite: true, outputMediaType: 'text/plain' };
    expect(p.cite).toBe(true);
    expect(p.outputMediaType).toBe('text/plain');
  });
});
