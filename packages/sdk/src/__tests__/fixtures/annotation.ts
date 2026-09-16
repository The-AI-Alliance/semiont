/**
 * A valid W3C `Annotation`, for tests that need one to exist rather than to
 * be interesting.
 *
 * Shared because it was hand-written in at least three test files, and
 * because under-shaped versions of it (`{ id: 'a1' }`) were riding into
 * typed bus channels behind `as unknown as` casts on the transport double —
 * so a fixture that was not an Annotation at all typechecked fine. Build one
 * here; override the fields a test actually asserts on.
 */

import { annotationId } from '@semiont/core';
import type { Annotation } from '@semiont/core';

export function mockAnnotation(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(id),
    motivation: 'commenting',
    created: '2026-01-01T00:00:00Z',
    target: { source: 'res-1' },
    body: [{ type: 'TextualBody', value: 'test comment', purpose: 'commenting' }],
    ...overrides,
  };
}
