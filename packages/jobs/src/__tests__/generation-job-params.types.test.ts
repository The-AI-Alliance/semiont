import { describe, it, expect } from 'vitest';
import type { GenerationJobParams, GatheredContext } from '@semiont/core';
import { resourceId } from '@semiont/core';

/**
 * tsc-enforced contract for the generation params bag — the SHARED wire type,
 * generated from the spec schema and consumed by both the sdk (write side)
 * and the worker (read side).
 *
 * Requiredness is decided once, in the schema — `title`, `storageUri`, and
 * `context` are required on the wire, and `{}` does not compile (the
 * inverted pin below holds that door shut).
 */

const CONTEXT: GatheredContext = {
  focus: {
    kind: 'resource',
    resource: {
      '@context': 'https://semiont.dev/context/v1',
      '@id': resourceId('res-src'),
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

  it('the empty bag does not compile — requiredness is the wire\'s law', () => {
    // @ts-expect-error — title, storageUri, and context are required.
    const p: GenerationJobParams = {};
    expect(p).toEqual({});
  });

  it('task and structure accept canonical values AND arbitrary strings', () => {
    // The wire type is `string` — the canonical values live in the schema
    // description and the worker's loud-degrade handling.
    const canonical: GenerationJobParams = { ...REQUIRED, task: 'answer', structure: 'prose' };
    const custom: GenerationJobParams = {
      ...REQUIRED,
      task: 'Translate the source into idiomatic French',
      structure: 'a bulleted list of key facts',
    };
    expect(canonical.task).toBe('answer');
    expect(custom.structure).toBe('a bulleted list of key facts');
  });

  // `cite` asks for inline citations; `outputMediaType` is the format the
  // worker checks against the registry's generatable media types.
  it('accepts cite and outputMediaType', () => {
    const p: GenerationJobParams = { ...REQUIRED, cite: true, outputMediaType: 'text/plain' };
    expect(p.cite).toBe(true);
    expect(p.outputMediaType).toBe('text/plain');
  });
});
