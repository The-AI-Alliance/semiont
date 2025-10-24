/**
 * Selector Utilities
 *
 * Helper functions for working with W3C Web Annotation selectors
 * These utilities are copied from SDK for frontend use
 */

import type { Annotation } from './types';

// Selector types extracted from Annotation type
export type TextPositionSelector = {
  type: 'TextPositionSelector';
  exact: string;
  offset: number;
  length: number;
};

export type TextQuoteSelector = {
  type: 'TextQuoteSelector';
  exact: string;
  prefix?: string;
  suffix?: string;
};

export type Selector = TextPositionSelector | TextQuoteSelector;

/**
 * Get the exact text from a selector (single or array)
 *
 * When selector is an array, returns the exact text from the first selector.
 * All selectors in an array should point to the same text, so first is preferred.
 * Handles undefined selector (when target is a string IRI with no selector)
 */
export function getExactText(selector: Selector | Selector[] | undefined): string {
  if (!selector) {
    return ''; // No selector means entire resource
  }
  if (Array.isArray(selector)) {
    if (selector.length === 0) {
      throw new Error('Empty selector array');
    }
    const first = selector[0];
    if (!first) {
      throw new Error('Invalid selector array');
    }
    return first.exact;
  }
  return selector.exact;
}

/**
 * Get the exact text from an annotation's target selector
 * Uses getTargetSelector helper to safely get selector
 */
export function getAnnotationExactText(annotation: Annotation): string {
  // Import the helper at runtime to avoid circular dependencies
  const { getTargetSelector } = require('./annotation-utils');
  const selector = getTargetSelector(annotation.target);
  return getExactText(selector as Selector | Selector[] | undefined);
}

/**
 * Get the primary selector from a selector (single or array)
 *
 * When selector is an array, returns the first selector.
 * When selector is a single object, returns it as-is.
 */
export function getPrimarySelector(selector: Selector | Selector[]): Selector {
  if (Array.isArray(selector)) {
    if (selector.length === 0) {
      throw new Error('Empty selector array');
    }
    const first = selector[0];
    if (!first) {
      throw new Error('Invalid selector array');
    }
    return first;
  }
  return selector;
}

/**
 * Get TextPositionSelector from a selector (single or array)
 *
 * Returns the first TextPositionSelector found, or null if none exists.
 * Handles undefined selector (when target is a string IRI with no selector)
 */
export function getTextPositionSelector(selector: Selector | Selector[] | undefined): TextPositionSelector | null {
  if (!selector) return null; // No selector means entire resource
  const selectors = Array.isArray(selector) ? selector : [selector];
  const found = selectors.find(s => s.type === 'TextPositionSelector');
  if (!found) return null;
  return found.type === 'TextPositionSelector' ? found : null;
}

/**
 * Get TextQuoteSelector from a selector (single or array)
 *
 * Returns the first TextQuoteSelector found, or null if none exists.
 */
export function getTextQuoteSelector(selector: Selector | Selector[]): TextQuoteSelector | null {
  const selectors = Array.isArray(selector) ? selector : [selector];
  const found = selectors.find(s => s.type === 'TextQuoteSelector');
  if (!found) return null;
  return found.type === 'TextQuoteSelector' ? found : null;
}
