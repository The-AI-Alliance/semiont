/**
 * Annotation utility functions
 * Copied from SDK for frontend use
 *
 * Body is either empty array (stub) or single SpecificResource (resolved)
 * Body can be array of TextualBody (tagging) + SpecificResource (linking)
 * Target can be simple string IRI or object with source and optional selector
 */

import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type HighlightAnnotation = Annotation;
type ReferenceAnnotation = Annotation;

/**
 * Get the source from an annotation body (null if stub)
 * Search for SpecificResource in body array
 */
export function getBodySource(body: Annotation['body']): string | null {
  if (Array.isArray(body)) {
    // Search for SpecificResource with source
    for (const item of body) {
      if (
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        'source' in item
      ) {
        const itemType = (item as { type: unknown }).type;
        const itemSource = (item as { source: unknown }).source;

        if (itemType === 'SpecificResource' && typeof itemSource === 'string') {
          return itemSource;
        }
      }
    }
    return null; // No SpecificResource found = stub
  }

  // Single body object (SpecificResource)
  if (
    typeof body === 'object' &&
    body !== null &&
    'type' in body &&
    'source' in body
  ) {
    const bodyType = (body as { type: unknown }).type;
    const bodySource = (body as { source: unknown }).source;

    if (bodyType === 'SpecificResource' && typeof bodySource === 'string') {
      return bodySource;
    }
  }

  return null;
}

/**
 * Get the type from an annotation body (returns first body type in array)
 */
export function getBodyType(body: Annotation['body']): 'TextualBody' | 'SpecificResource' | null {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return null;
    }
    // Return type of first body item
    if (typeof body[0] === 'object' && body[0] !== null && 'type' in body[0]) {
      const firstType = (body[0] as { type: unknown }).type;
      if (firstType === 'TextualBody' || firstType === 'SpecificResource') {
        return firstType;
      }
    }
    return null;
  }

  // Single body object
  if (typeof body === 'object' && body !== null && 'type' in body) {
    const bodyType = (body as { type: unknown }).type;
    if (bodyType === 'TextualBody' || bodyType === 'SpecificResource') {
      return bodyType;
    }
  }

  return null;
}

/**
 * Check if body is resolved (has a source)
 * Check for SpecificResource in body array
 */
export function isBodyResolved(body: Annotation['body']): boolean {
  return getBodySource(body) !== null;
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
 * Extract entity types from annotation bodies
 * Entity types are stored as TextualBody with purpose: "tagging"
 */
export function getEntityTypes(annotation: Annotation): string[] {
  // Extract from TextualBody bodies with purpose: "tagging"
  if (Array.isArray(annotation.body)) {
    const entityTags: string[] = [];

    for (const item of annotation.body) {
      // Runtime check for TextualBody with tagging purpose
      // TypeScript incorrectly narrows the union type here, so we use runtime checks only
      if (
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        'value' in item &&
        'purpose' in item
      ) {
        // Access properties as unknown first to avoid TypeScript narrowing issues
        const itemType = (item as { type: unknown }).type;
        const itemValue = (item as { value: unknown }).value;
        const itemPurpose = (item as { purpose: unknown }).purpose;

        if (itemType === 'TextualBody' && itemPurpose === 'tagging' && typeof itemValue === 'string' && itemValue.length > 0) {
          entityTags.push(itemValue);
        }
      }
    }

    return entityTags;
  }

  return [];
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
 * Stub if no SpecificResource in body array
 */
export function isStubReference(annotation: Annotation): boolean {
  return isReference(annotation) && !isBodyResolved(annotation.body);
}

/**
 * Type guard to check if a reference annotation is resolved
 * Resolved if SpecificResource exists in body array
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
