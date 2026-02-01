/**
 * Annotation and Selector Utilities
 *
 * Pure TypeScript utilities for working with W3C Web Annotations.
 * No React dependencies - safe to use in any JavaScript environment.
 *
 * Body is either empty array (stub) or single SpecificResource (resolved)
 * Body can be array of TextualBody (tagging) + SpecificResource (linking)
 * Target can be simple string IRI or object with source and optional selector
 */

import type { components } from '../types';
import type { ResourceUri } from '../branded-types';
import { resourceUri } from '../branded-types';

type Annotation = components['schemas']['Annotation'];
type HighlightAnnotation = Annotation;
type ReferenceAnnotation = Annotation;
type TextPositionSelector = components['schemas']['TextPositionSelector'];
type TextQuoteSelector = components['schemas']['TextQuoteSelector'];
type SvgSelector = components['schemas']['SvgSelector'];
type FragmentSelector = components['schemas']['FragmentSelector'];
type Selector = TextPositionSelector | TextQuoteSelector | SvgSelector | FragmentSelector;

// Re-export selector types for convenience
export type { TextPositionSelector, TextQuoteSelector, SvgSelector, FragmentSelector, Selector };

/**
 * Get the source from an annotation body (null if stub)
 * Search for SpecificResource in body array
 */
export function getBodySource(body: Annotation['body']): ResourceUri | null {
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
          return resourceUri(itemSource);
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
      return resourceUri(bodySource);
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
export function getTargetSource(target: Annotation['target']): ResourceUri {
  if (typeof target === 'string') {
    return resourceUri(target);
  }
  return resourceUri(target.source);
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

/**
 * Get SvgSelector from a selector (single or array)
 *
 * Returns the first SvgSelector found, or null if none exists.
 */
export function getSvgSelector(selector: Selector | Selector[] | undefined): SvgSelector | null {
  if (!selector) return null;
  const selectors = Array.isArray(selector) ? selector : [selector];
  const found = selectors.find(s => s.type === 'SvgSelector');
  if (!found) return null;
  return found.type === 'SvgSelector' ? found : null;
}

/**
 * Get FragmentSelector from a selector (single or array)
 *
 * Returns the first FragmentSelector found, or null if none exists.
 */
export function getFragmentSelector(selector: Selector | Selector[] | undefined): FragmentSelector | null {
  if (!selector) return null;
  const selectors = Array.isArray(selector) ? selector : [selector];
  const found = selectors.find(s => s.type === 'FragmentSelector');
  if (!found) return null;
  return found.type === 'FragmentSelector' ? found : null;
}

/**
 * Validate SVG markup for W3C compliance
 *
 * Checks that:
 * - SVG contains xmlns attribute
 * - SVG is well-formed XML
 * - SVG contains at least one shape element
 *
 * @returns null if valid, error message if invalid
 */
export function validateSvgMarkup(svg: string): string | null {
  // Check for xmlns attribute (required by W3C spec)
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
    return 'SVG must include xmlns="http://www.w3.org/2000/svg" attribute';
  }

  // Check for basic SVG tag structure
  if (!svg.includes('<svg') || !svg.includes('</svg>')) {
    return 'SVG must have opening and closing tags';
  }

  // Check for at least one shape element
  const shapeElements = ['rect', 'circle', 'ellipse', 'polygon', 'polyline', 'path', 'line'];
  const hasShape = shapeElements.some(shape =>
    svg.includes(`<${shape}`) || svg.includes(`<${shape} `)
  );

  if (!hasShape) {
    return 'SVG must contain at least one shape element (rect, circle, ellipse, polygon, polyline, path, or line)';
  }

  return null; // Valid
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
