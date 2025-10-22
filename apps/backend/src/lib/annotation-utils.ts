/**
 * Annotation utility functions for Phase 1 schema changes
 *
 * Phase 1: Body is either empty array (stub) or single SpecificResource (resolved)
 * Phase 1: Target can be simple string IRI or object with source and optional selector
 * Phase 1: entityTypes temporarily at annotation level (will move to TextualBody in Phase 2)
 */

import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type AnnotationTarget = components['schemas']['AnnotationTarget'];

/**
 * Get the source from an annotation body (empty string if stub)
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
