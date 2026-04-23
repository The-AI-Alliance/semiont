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
  // Body is optional — motivation:'highlighting' annotations carry no
  // body per W3C. Other motivations always populate it; graph consumers
  // that need to read `body` on non-highlights should assert its
  // presence based on motivation rather than treat it as guaranteed.
  body?: Annotation['body'];
  creator: components['schemas']['Agent'];
}
