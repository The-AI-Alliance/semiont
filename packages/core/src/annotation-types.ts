/**
 * Annotation types
 */

import type { components } from './types';

type Annotation = components['schemas']['Annotation'];

export type AnnotationCategory = 'highlight' | 'reference';

export interface CreateAnnotationInternal {
  id: string;
  motivation: Annotation['motivation'];
  target: Annotation['target'];
  body: Annotation['body'];
  creator: components['schemas']['Agent'];
}
