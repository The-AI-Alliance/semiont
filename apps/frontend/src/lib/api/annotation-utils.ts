/**
 * Annotation utility functions
 * Copied from SDK for frontend use
 */

import type { Annotation, HighlightAnnotation, ReferenceAnnotation } from './types';

/**
 * Type guard to check if an annotation is a highlight
 */
export function isHighlight(annotation: Annotation): annotation is HighlightAnnotation {
  return annotation.motivation === 'highlighting';
}

/**
 * Type guard to check if an annotation is a reference (linking)
 */
export function isReference(annotation: Annotation): annotation is ReferenceAnnotation {
  return annotation.motivation === 'linking';
}

/**
 * Type guard to check if a reference annotation is a stub (unresolved)
 * Stub references don't have a target document yet
 */
export function isStubReference(annotation: Annotation): boolean {
  return isReference(annotation) && !annotation.body.source;
}

/**
 * Type guard to check if a reference annotation is resolved
 * Resolved references have body.source pointing to a document ID
 */
export function isResolvedReference(annotation: Annotation): annotation is ReferenceAnnotation {
  return (
    annotation.motivation === 'linking' &&
    annotation.body.type === 'SpecificResource' &&
    annotation.body.source !== null &&
    annotation.body.source !== undefined
  );
}

/**
 * Extract annotation ID from a full URI or just the ID
 * @param fullUriOrId - Full URI like "urn:uuid:abc-123", "http://host/annotations/abc-123", or just "abc-123"
 * @returns The ID portion (e.g., "abc-123")
 */
export function extractAnnotationId(fullUriOrId: string): string {
  // Handle URN format: urn:uuid:abc-123
  if (fullUriOrId.startsWith('urn:uuid:')) {
    return fullUriOrId.replace('urn:uuid:', '');
  }

  // Handle HTTP/HTTPS URLs: http://host/annotations/abc-123
  if (fullUriOrId.startsWith('http://') || fullUriOrId.startsWith('https://')) {
    const parts = fullUriOrId.split('/');
    return parts[parts.length - 1];
  }

  // Already just an ID
  return fullUriOrId;
}

/**
 * Compare two annotation IDs, handling both URN format and plain IDs
 */
export function compareAnnotationIds(id1: string, id2: string): boolean {
  const extracted1 = extractAnnotationId(id1);
  const extracted2 = extractAnnotationId(id2);
  return extracted1 === extracted2;
}
