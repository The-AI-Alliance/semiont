/**
 * Annotation Assembly
 *
 * Pure functions for building W3C Annotations and applying body operations.
 * No EventBus, no persistence — just data transformation.
 */
import type { components } from './types';
import type { Selector } from './payload-types';
import type { Annotation } from './annotation-types';
type Agent = components['schemas']['Agent'];
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
/**
 * Get TextPositionSelector from a selector (single or array)
 */
export declare function getTextPositionSelector(selector: Selector | Selector[] | undefined): TextPositionSelector | null;
/**
 * Get SvgSelector from a selector (single or array)
 */
export declare function getSvgSelector(selector: Selector | Selector[] | undefined): SvgSelector | null;
/**
 * Get FragmentSelector from a selector (single or array)
 */
export declare function getFragmentSelector(selector: Selector | Selector[] | undefined): FragmentSelector | null;
/**
 * Validate SVG markup for W3C compliance
 *
 * @returns null if valid, error message if invalid
 */
export declare function validateSvgMarkup(svg: string): string | null;
/**
 * Build a complete W3C Annotation from a CreateAnnotationRequest.
 *
 * Generates a bare annotation ID (no URL prefix). URIs are constructed
 * at the API boundary when returning responses to clients.
 *
 * Throws on invalid input (missing motivation, invalid SVG markup). The target
 * selector is OPTIONAL — a source-only target annotates the whole resource (W3C;
 * e.g. resource-level edges), per RESOURCE-LEVEL-ANCHOR.
 */
export declare function assembleAnnotation(request: CreateAnnotationRequest, creator: Agent): AssembledAnnotation;
/**
 * Apply body operations (add/remove/replace) to an annotation's body array.
 * Returns a new array — does not mutate the input.
 */
export declare function applyBodyOperations(body: Annotation['body'], operations: UpdateAnnotationBodyRequest['operations']): AnnotationBody[];
export {};
