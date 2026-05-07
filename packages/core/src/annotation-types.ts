/**
 * Annotation types
 */

import type { components } from './types';
import type { AnnotationId } from './identifiers';

type RawAnnotation = components['schemas']['Annotation'];

/**
 * Domain-level Annotation type. Same shape as the OpenAPI-generated
 * `components['schemas']['Annotation']`, but with a branded `AnnotationId`
 * for the `id` field. Use this import everywhere the codebase refers to
 * "an annotation"; the raw OpenAPI type is only used inside
 * `@semiont/api-client` at the HTTP boundary.
 *
 * Implemented by intersection (not `Omit`) to be robust against generator
 * drift — if the OpenAPI schema gets `additionalProperties: true` added,
 * `Omit` on the resulting intersection type silently drops named fields.
 */
export type Annotation = RawAnnotation & { id: AnnotationId };

export type AnnotationCategory = 'highlight' | 'reference';

export interface CreateAnnotationInternal {
  id: AnnotationId;
  motivation: Annotation['motivation'];
  target: Annotation['target'];
  // Body is optional — motivation:'highlighting' annotations carry no
  // body per W3C. Other motivations always populate it; graph consumers
  // that need to read `body` on non-highlights should assert its
  // presence based on motivation rather than treat it as guaranteed.
  body?: Annotation['body'];
  creator: components['schemas']['Agent'];
}
