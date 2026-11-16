/**
 * Identifier utilities for event sourcing
 */

import { nanoid } from 'nanoid';
import { annotationId, type AnnotationId } from '@semiont/core';

/**
 * Generate a unique annotation ID (bare nanoid)
 *
 * Returns the branded type: this function is where an annotation id comes
 * into existence, so it is the natural place to brand — every caller is
 * constructing an `Annotation`, and branding here spares them all a cast
 * (BRAND-UPSTREAM: brand at the boundary, not at every hop).
 *
 * @returns A bare annotation ID (e.g., "V1StGXR8_Z5jdHi6B-myT")
 */
export function generateAnnotationId(): AnnotationId {
  return annotationId(nanoid(21));
}
