/**
 * Annotation and Selector Utilities
 *
 * Pure TypeScript utilities for working with W3C Web Annotations.
 * No React dependencies - safe to use in any JavaScript environment.
 *
 * Body is either empty array (stub) or single SpecificResource (resolved)
 * Body can be array of TextualBody (tagging) + SpecificResource (linking)
 * Target can be a resource's id or an object with source and optional selector
 */

import type { components } from './types';
import type { Selector } from './payload-types';
import type { Annotation } from './annotation-types';
import type { ResourceId } from './identifiers';

// Re-export selector utilities (canonical location is annotation-assembly)
export {
  getTextPositionSelector,
  getSvgSelector,
  getFragmentSelector,
  validateSvgMarkup,
} from './annotation-assembly';
type HighlightAnnotation = Annotation;
type ReferenceAnnotation = Annotation;
type TextPositionSelector = components['schemas']['TextPositionSelector'];
type TextQuoteSelector = components['schemas']['TextQuoteSelector'];
type SvgSelector = components['schemas']['SvgSelector'];
type FragmentSelector = components['schemas']['FragmentSelector'];

// Re-export selector types for convenience
export type { TextPositionSelector, TextQuoteSelector, SvgSelector, FragmentSelector, Selector };

/** A body's items: none when there is no body, the one when it is a single item, each when it is a list. */
function bodyItems(body: Annotation['body']) {
  return body === undefined ? [] : Array.isArray(body) ? body : [body];
}

/**
 * Get the source from an annotation body (null if stub)
 * Search for SpecificResource in body array
 */
export function getBodySource(body: Annotation['body']): ResourceId | null {
  for (const item of bodyItems(body)) {
    if (item.type === 'SpecificResource') return item.source;
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
 * The resource a target names (handles both string and object forms)
 */
export function getTargetSource(target: Annotation['target']): ResourceId {
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
 * Type guard to check if an annotation is an assessment
 */
export function isAssessment(annotation: Annotation): annotation is Annotation {
  return annotation.motivation === 'assessing';
}

/**
 * Type guard to check if an annotation is a comment
 */
export function isComment(annotation: Annotation): annotation is Annotation {
  return annotation.motivation === 'commenting';
}

/**
 * Type guard to check if an annotation is a tag
 */
export function isTag(annotation: Annotation): annotation is Annotation {
  return annotation.motivation === 'tagging';
}

/**
 * Extract comment text from a comment annotation's body
 * @param annotation - The annotation to extract comment text from
 * @returns The comment text, or undefined if not a comment or no text found
 */
export function getCommentText(annotation: Annotation): string | undefined {
  if (!isComment(annotation)) return undefined;
  const body = Array.isArray(annotation.body) ? annotation.body[0] : annotation.body;
  if (body && 'value' in body) {
    return body.value;
  }
  return undefined;
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
 * The entity types an annotation states: the text of each body that tags, in
 * the order its body has them. A body with no text states none.
 *
 * Takes anything with an annotation's `body`: one item, a list, or none
 * (a highlight has none).
 */
export function getEntityTypes(annotation: { body?: Annotation['body'] }): string[] {
  const types: string[] = [];
  for (const item of bodyItems(annotation.body)) {
    if (item.type === 'TextualBody' && item.purpose === 'tagging' && item.value.length > 0) {
      types.push(item.value);
    }
  }
  return types;
}

/** The text of the first body that states it for `purpose`. */
function textFor(body: Annotation['body'], purpose: 'tagging' | 'classifying'): string | undefined {
  for (const item of bodyItems(body)) {
    if (item.type === 'TextualBody' && item.purpose === purpose) return item.value;
  }
  return undefined;
}

/**
 * A tag's category (e.g. "Issue", "Rule"): the text of its body that tags.
 * Nothing for an annotation that is not a tag.
 */
export function getTagCategory(annotation: Annotation): string | undefined {
  return isTag(annotation) ? textFor(annotation.body, 'tagging') : undefined;
}

/**
 * The id of the schema a tag's category is of (e.g. "legal-irac"): the text
 * of its body that classifies. Nothing for an annotation that is not a tag.
 */
export function getTagSchemaId(annotation: Annotation): string | undefined {
  return isTag(annotation) ? textFor(annotation.body, 'classifying') : undefined;
}

// =============================================================================
// SELECTOR UTILITIES
// =============================================================================

/**
 * Get the exact text from a selector (single or array)
 *
 * When selector is an array, tries to find a TextQuoteSelector (which has exact text).
 * TextPositionSelector does not have exact text, only character offsets.
 * Handles undefined selector (when target is a string IRI with no selector)
 */
export function getExactText(selector: Selector | Selector[] | undefined): string {
  if (!selector) {
    return ''; // No selector means entire resource
  }
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
 * Uses getTargetSelector helper to safely get selector
 */
export function getAnnotationExactText(annotation: Annotation): string {
  const selector = getTargetSelector(annotation.target);
  return getExactText(selector as Selector | Selector[] | undefined);
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

/**
 * Extract bounding box from SVG markup
 *
 * Attempts to extract x, y, width, height from the SVG viewBox or root element.
 * Returns null if bounding box cannot be determined.
 */
export function extractBoundingBox(svg: string): { x: number; y: number; width: number; height: number } | null {
  // Try to extract viewBox attribute from SVG element
  const viewBoxMatch = svg.match(/<svg[^>]*viewBox="([^"]+)"/);
  if (viewBoxMatch) {
    const values = viewBoxMatch[1].split(/\s+/).map(parseFloat);
    if (values.length === 4 && values.every(v => !isNaN(v))) {
      return {
        x: values[0],
        y: values[1],
        width: values[2],
        height: values[3]
      };
    }
  }

  // Try to extract width/height attributes from SVG element (assume x=0, y=0)
  const svgTagMatch = svg.match(/<svg[^>]*>/);
  if (svgTagMatch) {
    const svgTag = svgTagMatch[0];
    const widthMatch = svgTag.match(/width="([^"]+)"/);
    const heightMatch = svgTag.match(/height="([^"]+)"/);

    if (widthMatch && heightMatch) {
      const width = parseFloat(widthMatch[1]);
      const height = parseFloat(heightMatch[1]);

      if (!isNaN(width) && !isNaN(height)) {
        return { x: 0, y: 0, width, height };
      }
    }
  }

  return null;
}
