import { describe, it, expect, expectTypeOf } from 'vitest';
import type { GenerationJobParams, GatheredContext } from '@semiont/core';
import { isGenerationJobParams } from '@semiont/core';
import { processGenerationJob } from '../processors';

/**
 * YIELD-FROM-CONTEXT P1: the generation params boundary is ONE type, shared.
 *
 * The wire schema (`GenerationJobParams` in specs) generates the core type; the
 * worker narrows `job.params` through `isGenerationJobParams` instead of
 * `as GenerationParams`; and the processor's parameter IS the generated type —
 * pinned below with `expectTypeOf`, so the sdk (write side) and the worker
 * (read side) can no longer drift a field apart silently.
 *
 * RED before P1 lands: the generated type and the guard don't exist.
 */

// Minimal HONEST context — every field satisfies the generated type with no
// casts, so this fixture breaks loudly if the schema's required set moves.
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

const VALID: GenerationJobParams = {
  title: 'Answer',
  storageUri: 'file://generated/answer.md',
  context: CONTEXT,
};

describe('isGenerationJobParams (the worker-side boundary guard)', () => {
  it('accepts the minimal valid bag (required trio present)', () => {
    expect(isGenerationJobParams(VALID)).toBe(true);
  });

  it('accepts the full bag (optionals ride through)', () => {
    expect(
      isGenerationJobParams({
        ...VALID,
        referenceId: 'ann-1',
        prompt: 'Be concise.',
        task: 'answer',
        structure: 'prose',
        cite: true,
        temperature: 0.2,
      }),
    ).toBe(true);
  });

  it('rejects a bag whose context is not an object', () => {
    expect(isGenerationJobParams({ ...VALID, context: 42 })).toBe(false);
  });

  it('rejects the required trio going missing — title, storageUri, context each', () => {
    const { title: _t, ...noTitle } = VALID;
    const { storageUri: _s, ...noStorage } = VALID;
    const { context: _c, ...noContext } = VALID;
    expect(isGenerationJobParams(noTitle)).toBe(false);
    expect(isGenerationJobParams(noStorage)).toBe(false);
    expect(isGenerationJobParams(noContext)).toBe(false);
  });

  it('rejects non-objects outright', () => {
    expect(isGenerationJobParams(null)).toBe(false);
    expect(isGenerationJobParams('generation')).toBe(false);
    expect(isGenerationJobParams([])).toBe(false);
  });
});

describe('the processor consumes the SHARED type — no parallel dictionary', () => {
  it('processGenerationJob params parameter IS core GenerationJobParams', () => {
    expectTypeOf<Parameters<typeof processGenerationJob>[1]>()
      .toEqualTypeOf<GenerationJobParams>();
  });
});
