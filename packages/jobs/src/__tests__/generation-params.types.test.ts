import { describe, it, expect } from 'vitest';
import type { GenerationParams } from '../types';

/**
 * tsc-enforced guard for the YIELD-FROM-RESOURCE P1 param contract: generation is
 * annotation-OPTIONAL and carries `outputMediaType`. RED before P1 — `referenceId`/
 * `sourceResourceId`/`sourceResourceName`/`annotation` were required and there was no
 * `outputMediaType` (this file fails `tsc --noEmit` until the type is reshaped).
 */
describe('GenerationParams contract', () => {
  it('accepts annotation-free params carrying outputMediaType', () => {
    const p: GenerationParams = { prompt: 'Translate to French', outputMediaType: 'text/plain' };
    expect(p.outputMediaType).toBe('text/plain');
  });

  it('requires no fields — referenceId is optional and the annotation fields are gone', () => {
    const p: GenerationParams = {};
    expect(p).toEqual({});
  });
});
