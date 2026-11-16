/**
 * Type-level guard — RESOURCE-LEVEL-ANCHOR P1.
 *
 * A create-annotation target is selector-OPTIONAL: a whole resource (an edge
 * endpoint, a whole-resource note) is targeted by `{ source }` alone, no
 * selector — per the W3C Web Annotation model and `AnnotationTarget.json`.
 *
 * These assertions are enforced by `tsc --noEmit` (core's `typecheck`), not at
 * vitest runtime (esbuild strips the types). The source-only case is RED on the
 * pre-P1 generated type (`required: ["source","selector"]`) and GREEN after the
 * `$ref AnnotationTarget` swap + regen. The behavioral RED→GREEN — the backend's
 * `validate-openapi` runtime gate — lands in P2.
 */
import { describe, it, expect } from 'vitest';
import type { components } from '../types';

type CreateTarget = components['schemas']['CreateAnnotationRequest']['target'];

describe('CreateAnnotationRequest target (P1: selector-optional)', () => {
  it('accepts a source-only target (no selector)', () => {
    const sourceOnly: CreateTarget = { source: 'http://localhost:4000/resources/r-1' };
    expect(sourceOnly.source).toContain('r-1');
  });

  it('still accepts a target with a selector (no regression)', () => {
    const withSelector: CreateTarget = {
      source: 'http://localhost:4000/resources/r-1',
      selector: { type: 'TextQuoteSelector', exact: 'hello' },
    };
    expect(withSelector.selector).toBeDefined();
  });

  it('still requires source', () => {
    // @ts-expect-error — source is required on a create target
    const missingSource: CreateTarget = { selector: { type: 'TextQuoteSelector', exact: 'x' } };
    void missingSource;
    expect(true).toBe(true);
  });
});
