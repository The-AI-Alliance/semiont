/**
 * Annotation Assembly
 *
 * Pure functions for building W3C Annotations and applying body operations.
 * No EventBus, no persistence — just data transformation.
 */

import type { components } from './types';
import type { Selector } from './bus-protocol';
import { generateUuid } from './id-generation';

type Agent = components['schemas']['Agent'];
type Annotation = components['schemas']['Annotation'];
type AnnotationBody = components['schemas']['AnnotationBody'];
type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
type UpdateAnnotationBodyRequest = components['schemas']['UpdateAnnotationBodyRequest'];
type TextPositionSelector = components['schemas']['TextPositionSelector'];
type SvgSelector = components['schemas']['SvgSelector'];
type FragmentSelector = components['schemas']['FragmentSelector'];

export interface AssembledAnnotation {
  annotation: Annotation;
  bodyArray: AnnotationBody[];
}

// =============================================================================
// Selector utilities used by assembleAnnotation
// =============================================================================

/**
 * Get TextPositionSelector from a selector (single or array)
 */
export function getTextPositionSelector(selector: Selector | Selector[] | undefined): TextPositionSelector | null {
  if (!selector) return null;
  const selectors = Array.isArray(selector) ? selector : [selector];
  const found = selectors.find(s => s.type === 'TextPositionSelector');
  if (!found) return null;
  return found.type === 'TextPositionSelector' ? found : null;
}

/**
 * Get SvgSelector from a selector (single or array)
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
 * @returns null if valid, error message if invalid
 */
export function validateSvgMarkup(svg: string): string | null {
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
    return 'SVG must include xmlns="http://www.w3.org/2000/svg" attribute';
  }

  if (!svg.includes('<svg') || !svg.includes('</svg>')) {
    return 'SVG must have opening and closing tags';
  }

  const shapeElements = ['rect', 'circle', 'ellipse', 'polygon', 'polyline', 'path', 'line'];
  const hasShape = shapeElements.some(shape =>
    svg.includes(`<${shape}`) || svg.includes(`<${shape} `)
  );

  if (!hasShape) {
    return 'SVG must contain at least one shape element (rect, circle, ellipse, polygon, polyline, path, or line)';
  }

  return null;
}

// =============================================================================
// Annotation assembly
// =============================================================================

/**
 * Build a complete W3C Annotation from a CreateAnnotationRequest.
 *
 * Generates a bare annotation ID (no URL prefix). URIs are constructed
 * at the API boundary when returning responses to clients.
 *
 * Throws on invalid input (missing selector, missing motivation, invalid SVG).
 */
export function assembleAnnotation(
  request: CreateAnnotationRequest,
  creator: Agent,
): AssembledAnnotation {
  const newAnnotationId = generateUuid();

  // Validate selector: must have TextPositionSelector, SvgSelector, or FragmentSelector
  const posSelector = getTextPositionSelector(request.target.selector);
  const svgSelector = getSvgSelector(request.target.selector);
  const fragmentSelector = getFragmentSelector(request.target.selector);

  if (!posSelector && !svgSelector && !fragmentSelector) {
    throw new Error('Either TextPositionSelector, SvgSelector, or FragmentSelector is required for creating annotations');
  }

  // Validate SVG markup if SvgSelector is provided
  if (svgSelector) {
    const svgError = validateSvgMarkup(svgSelector.value);
    if (svgError) {
      throw new Error(`Invalid SVG markup: ${svgError}`);
    }
  }

  if (!request.motivation) {
    throw new Error('motivation is required');
  }

  const now = new Date().toISOString();
  const annotation: Annotation = {
    '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
    'type': 'Annotation' as const,
    id: newAnnotationId,
    motivation: request.motivation,
    target: request.target,
    body: request.body as Annotation['body'],
    creator,
    created: now,
    modified: now,
  };

  const bodyArray = (Array.isArray(request.body) ? request.body : request.body ? [request.body] : []) as AnnotationBody[];

  return { annotation, bodyArray };
}

/**
 * Apply body operations (add/remove/replace) to an annotation's body array.
 * Returns a new array — does not mutate the input.
 */
export function applyBodyOperations(
  body: Annotation['body'],
  operations: UpdateAnnotationBodyRequest['operations'],
): AnnotationBody[] {
  const bodyArray = Array.isArray(body) ? [...body] : [];

  for (const op of operations) {
    if (op.op === 'add') {
      const exists = bodyArray.some(item =>
        JSON.stringify(item) === JSON.stringify(op.item)
      );
      if (!exists) {
        bodyArray.push(op.item);
      }
    } else if (op.op === 'remove') {
      const index = bodyArray.findIndex(item =>
        JSON.stringify(item) === JSON.stringify(op.item)
      );
      if (index !== -1) {
        bodyArray.splice(index, 1);
      }
    } else if (op.op === 'replace') {
      const index = bodyArray.findIndex(item =>
        JSON.stringify(item) === JSON.stringify(op.oldItem)
      );
      if (index !== -1) {
        bodyArray[index] = op.newItem;
      }
    }
  }

  return bodyArray;
}
