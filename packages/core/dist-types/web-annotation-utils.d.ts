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
import type { components } from './types';
import type { Selector } from './payload-types';
import type { Annotation } from './annotation-types';
export { getTextPositionSelector, getSvgSelector, getFragmentSelector, validateSvgMarkup, } from './annotation-assembly';
type HighlightAnnotation = Annotation;
type ReferenceAnnotation = Annotation;
type TextPositionSelector = components['schemas']['TextPositionSelector'];
type TextQuoteSelector = components['schemas']['TextQuoteSelector'];
type SvgSelector = components['schemas']['SvgSelector'];
type FragmentSelector = components['schemas']['FragmentSelector'];
export type { TextPositionSelector, TextQuoteSelector, SvgSelector, FragmentSelector, Selector };
/**
 * Get the source from an annotation body (null if stub)
 * Search for SpecificResource in body array
 */
export declare function getBodySource(body: Annotation['body']): string | null;
/**
 * Get the type from an annotation body (returns first body type in array)
 */
export declare function getBodyType(body: Annotation['body']): 'TextualBody' | 'SpecificResource' | null;
/**
 * Check if body is resolved (has a source)
 * Check for SpecificResource in body array
 */
export declare function isBodyResolved(body: Annotation['body']): boolean;
/**
 * Get the source IRI from target (handles both string and object forms)
 */
export declare function getTargetSource(target: Annotation['target']): string;
/**
 * Get the selector from target (undefined if string or no selector)
 */
export declare function getTargetSelector(target: Annotation['target']): {
    type: "TextPositionSelector";
    start: number;
    end: number;
} | {
    type: "TextQuoteSelector";
    exact: string;
    prefix?: string;
    suffix?: string;
} | {
    type: "SvgSelector";
    value: string;
} | {
    type: "FragmentSelector";
    value: string;
    conformsTo?: string;
} | ({
    type: "TextPositionSelector";
    start: number;
    end: number;
} | {
    type: "TextQuoteSelector";
    exact: string;
    prefix?: string;
    suffix?: string;
} | {
    type: "SvgSelector";
    value: string;
} | {
    type: "FragmentSelector";
    value: string;
    conformsTo?: string;
})[] | undefined;
/**
 * Check if target has a selector
 */
export declare function hasTargetSelector(target: Annotation['target']): boolean;
/**
 * Type guard to check if an annotation is a highlight
 */
export declare function isHighlight(annotation: Annotation): annotation is HighlightAnnotation;
/**
 * Type guard to check if an annotation is a reference (linking)
 */
export declare function isReference(annotation: Annotation): annotation is ReferenceAnnotation;
/**
 * Type guard to check if an annotation is an assessment
 */
export declare function isAssessment(annotation: Annotation): annotation is Annotation;
/**
 * Type guard to check if an annotation is a comment
 */
export declare function isComment(annotation: Annotation): annotation is Annotation;
/**
 * Type guard to check if an annotation is a tag
 */
export declare function isTag(annotation: Annotation): annotation is Annotation;
/**
 * Extract comment text from a comment annotation's body
 * @param annotation - The annotation to extract comment text from
 * @returns The comment text, or undefined if not a comment or no text found
 */
export declare function getCommentText(annotation: Annotation): string | undefined;
/**
 * Type guard to check if a reference annotation is a stub (unresolved)
 * Stub if no SpecificResource in body array
 */
export declare function isStubReference(annotation: Annotation): boolean;
/**
 * Type guard to check if a reference annotation is resolved
 * Resolved if SpecificResource exists in body array
 */
export declare function isResolvedReference(annotation: Annotation): annotation is ReferenceAnnotation;
/**
 * Get the exact text from a selector (single or array)
 *
 * When selector is an array, tries to find a TextQuoteSelector (which has exact text).
 * TextPositionSelector does not have exact text, only character offsets.
 * Handles undefined selector (when target is a string IRI with no selector)
 */
export declare function getExactText(selector: Selector | Selector[] | undefined): string;
/**
 * Get the exact text from an annotation's target selector
 * Uses getTargetSelector helper to safely get selector
 */
export declare function getAnnotationExactText(annotation: Annotation): string;
/**
 * Get the primary selector from a selector (single or array)
 *
 * When selector is an array, returns the first selector.
 * When selector is a single object, returns it as-is.
 */
export declare function getPrimarySelector(selector: Selector | Selector[]): Selector;
/**
 * Get TextQuoteSelector from a selector (single or array)
 *
 * Returns the first TextQuoteSelector found, or null if none exists.
 */
export declare function getTextQuoteSelector(selector: Selector | Selector[]): TextQuoteSelector | null;
/**
 * Extract bounding box from SVG markup
 *
 * Attempts to extract x, y, width, height from the SVG viewBox or root element.
 * Returns null if bounding box cannot be determined.
 */
export declare function extractBoundingBox(svg: string): {
    x: number;
    y: number;
    width: number;
    height: number;
} | null;
