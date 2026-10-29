/**
 * Type-level guard — a create-annotation target needs no selector.
 *
 * A create-annotation target is selector-OPTIONAL: a whole resource (an edge
 * endpoint, a whole-resource note) is targeted by `{ source }` alone, no
 * selector — per the W3C Web Annotation model and `AnnotationTarget.json`.
 *
 * These assertions are enforced by `tsc --noEmit` (core's `typecheck`), not at
 * vitest runtime (esbuild strips the types). The source-only case fails to
 * compile on a generated type that requires the selector
 * (`required: ["source","selector"]`); it compiles because the request's
 * target is a `$ref` to `AnnotationTarget`.
 */
import { describe, it, expect } from 'vitest';
import type { components } from '../types';
import { resourceId } from '../identifiers';

type CreateTarget = components['schemas']['CreateAnnotationRequest']['target'];

describe('CreateAnnotationRequest target (selector-optional)', () => {
  it('accepts a source-only target (no selector)', () => {
    const sourceOnly: CreateTarget = { source: resourceId('r-1') };
    expect(sourceOnly.source).toContain('r-1');
  });

  it('accepts a target with a selector', () => {
    const withSelector: CreateTarget = {
      source: resourceId('r-1'),
      selector: { type: 'TextQuoteSelector', exact: 'hello' },
    };
    expect(withSelector.selector).toBeDefined();
  });

  it('requires source', () => {
    // @ts-expect-error — source is required on a create target
    const missingSource: CreateTarget = { selector: { type: 'TextQuoteSelector', exact: 'x' } };
    void missingSource;
    expect(true).toBe(true);
  });
});
