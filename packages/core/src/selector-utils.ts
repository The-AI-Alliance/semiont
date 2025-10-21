/**
 * Selector Utilities
 *
 * Helper functions for working with W3C Web Annotation selectors
 */

import type { components } from '@semiont/api-client';

// Import OpenAPI types
type Annotation = components['schemas']['Annotation'];
type Selector = components['schemas']['TextPositionSelector'] | components['schemas']['TextQuoteSelector'];
type TextPositionSelector = components['schemas']['TextPositionSelector'];
type TextQuoteSelector = components['schemas']['TextQuoteSelector'];

/**
 * Get the exact text from a selector (single or array)
 *
 * When selector is an array, returns the exact text from the first selector.
 * All selectors in an array should point to the same text, so first is preferred.
 */
export function getExactText(selector: Selector | Selector[]): string {
  if (Array.isArray(selector)) {
    return selector[0].exact;
  }
  return selector.exact;
}

/**
 * Get the exact text from an annotation's target selector
 * Accepts full Annotation or Omit<Annotation, 'creator' | 'created'>
 */
export function getAnnotationExactText(annotation: Annotation | Omit<Annotation, 'creator' | 'created'>): string {
  return getExactText(annotation.target.selector);
}

/**
 * Get the primary selector from a selector (single or array)
 *
 * When selector is an array, returns the first selector.
 * When selector is a single object, returns it as-is.
 */
export function getPrimarySelector(selector: Selector | Selector[]): Selector {
  if (Array.isArray(selector)) {
    return selector[0];
  }
  return selector;
}

/**
 * Get TextPositionSelector from a selector (single or array)
 *
 * Returns the first TextPositionSelector found, or null if none exists.
 */
export function getTextPositionSelector(selector: Selector | Selector[]): TextPositionSelector | null {
  const selectors = Array.isArray(selector) ? selector : [selector];
  const tps = selectors.find(s => s.type === 'TextPositionSelector');
  return tps as TextPositionSelector | null;
}

/**
 * Get TextQuoteSelector from a selector (single or array)
 *
 * Returns the first TextQuoteSelector found, or null if none exists.
 */
export function getTextQuoteSelector(selector: Selector | Selector[]): TextQuoteSelector | null {
  const selectors = Array.isArray(selector) ? selector : [selector];
  const tqs = selectors.find(s => s.type === 'TextQuoteSelector');
  return tqs as TextQuoteSelector | null;
}
