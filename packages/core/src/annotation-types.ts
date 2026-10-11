/**
 * Annotation types
 */

import type { components } from './types';

/** An annotation, as the spec states it: its `id` is an `AnnotationId`. */
export type Annotation = components['schemas']['Annotation'];

export type AnnotationCategory = 'highlight' | 'reference';
