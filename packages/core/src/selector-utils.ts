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
 * When selector is an array, tries to find a TextQuoteSelector (which has exact text).
 * TextPositionSelector does not have exact text, only character offsets.
 */
export function getExactText(selector: Selector | Selector[]): string {
  const selectors = Array.isArray(selector) ? selector : [selector];

  // Try to find TextQuoteSelector (has exact text)
  const quoteSelector = selectors.find(s => s.type === 'TextQuoteSelector') as TextQuoteSelector | undefined;
  if (quoteSelector) {
    return quoteSelector.exact;
  }

  // No TextQuoteSelector found
  return '';
}

/**
 * Get the exact text from an annotation's target selector
 * Accepts full Annotation or Omit<Annotation, 'creator' | 'created'>
 * Returns empty string if target is a simple IRI (no selector)
 */
export function getAnnotationExactText(annotation: Annotation | Omit<Annotation, 'creator' | 'created'>): string {
  // Target can be a simple string IRI (entire resource) or an object with selector (fragment)
  if (typeof annotation.target === 'string') {
    return ''; // No selector for entire resource
  }

  // Target has optional selector
  if (!annotation.target.selector) {
    return ''; // No selector provided
  }

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
