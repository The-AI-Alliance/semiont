/**
 * Annotation Assembly
 *
 * Pure functions for building W3C Annotations and applying body operations.
 * No EventBus, no persistence — just data transformation.
 */

import { generateAnnotationId } from '@semiont/event-sourcing';
import { getTextPositionSelector, getSvgSelector, getFragmentSelector, validateSvgMarkup } from '@semiont/api-client';
import type { components } from '@semiont/core';

type Agent = components['schemas']['Agent'];
type Annotation = components['schemas']['Annotation'];
type AnnotationBody = components['schemas']['AnnotationBody'];
type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
type UpdateAnnotationBodyRequest = components['schemas']['UpdateAnnotationBodyRequest'];

export interface AssembledAnnotation {
  annotation: Annotation;
  bodyArray: AnnotationBody[];
}

/**
 * Build a complete W3C Annotation from a CreateAnnotationRequest.
 *
 * Generates ID, validates selectors, constructs the full annotation object.
 * Throws on invalid input (missing selector, missing motivation, invalid SVG).
 */
export function assembleAnnotation(
  request: CreateAnnotationRequest,
  creator: Agent,
  publicURL: string,
): AssembledAnnotation {
  const newAnnotationId = generateAnnotationId(publicURL);

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
