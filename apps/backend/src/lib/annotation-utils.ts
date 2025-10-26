/**
 * Annotation utility functions 
 *
 * Body is either empty array (stub) or single SpecificResource (resolved)
 * Target can be simple string IRI or object with source and optional selector
 * entityTypes temporarily at annotation level (now use TextualBody with purpose: "tagging")
 */

import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type AnnotationTarget = components['schemas']['AnnotationTarget'];

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
export function getTargetSelector(target: Annotation['target']): AnnotationTarget['selector'] | undefined {
  if (typeof target === 'string') {
    return undefined;
  }
  return target.selector;
}

/**
 * Check if target has a selector
 */
export function hasTargetSelector(target: Annotation['target']): target is AnnotationTarget {
  return typeof target !== 'string' && target.selector !== undefined;
}
