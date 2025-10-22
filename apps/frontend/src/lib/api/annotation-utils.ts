/**
 * Annotation utility functions
 * Copied from SDK for frontend use
 *
 * Phase 1: Body is either empty array (stub) or single SpecificResource (resolved)
 * Phase 1: Target can be simple string IRI or object with source and optional selector
 * Phase 1: entityTypes temporarily at annotation level (will move to TextualBody in Phase 2)
 */

import type { Annotation, HighlightAnnotation, ReferenceAnnotation } from './types';

/**
 * Get the source from an annotation body (null if stub)
 */
export function getBodySource(body: Annotation['body']): string | null {
  if (Array.isArray(body)) {
    return null; // Stub reference (unresolved)
  }
  return body.source;
}

/**
 * Get the type from an annotation body
 */
export function getBodyType(body: Annotation['body']): 'SpecificResource' | null {
  if (Array.isArray(body)) {
    return null; // Stub has no type yet
  }
  return body.type;
}

/**
 * Check if body is resolved (has a source)
 */
export function isBodyResolved(body: Annotation['body']): body is { type: 'SpecificResource'; source: string; purpose?: 'linking' } {
  return !Array.isArray(body) && Boolean(body.source);
}

/**
 * Get the source IRI from target (handles both string and object forms)
 */
export function getTargetSource(target: Annotation['target']): string {
  if (typeof target === 'string') {
    return target;
  }
  return target.source;
}

/**
 * Get the selector from target (undefined if string or no selector)
 */
export function getTargetSelector(target: Annotation['target']) {
  if (typeof target === 'string') {
    return undefined;
  }
  return target.selector;
}

/**
 * Check if target has a selector
 */
export function hasTargetSelector(target: Annotation['target']): boolean {
  return typeof target !== 'string' && target.selector !== undefined;
}

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
 * Phase 1: Stub references have empty body array
 */
export function isStubReference(annotation: Annotation): boolean {
  return isReference(annotation) && Array.isArray(annotation.body);
}

/**
 * Type guard to check if a reference annotation is resolved
 * Phase 1: Resolved references have body with source
 */
export function isResolvedReference(annotation: Annotation): annotation is ReferenceAnnotation {
  return isReference(annotation) && isBodyResolved(annotation.body);
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
    const lastPart = parts[parts.length - 1];
    return lastPart || fullUriOrId; // Fallback to full URI if split fails
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
