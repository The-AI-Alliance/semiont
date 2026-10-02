/**
 * Annotation types
 */

import type { components } from './types';
import type { AnnotationId } from './identifiers';

/** An annotation, as the spec states it: its `id` is an `AnnotationId`. */
export type Annotation = components['schemas']['Annotation'];

export type AnnotationCategory = 'highlight' | 'reference';

export interface CreateAnnotationInternal {
  id: AnnotationId;
  motivation: Annotation['motivation'];
  target: Annotation['target'];
  // Body is optional — motivation:'highlighting' annotations carry no
  // body per W3C. Other motivations always populate it; consumers
  // (e.g. the Weaver) that need to read `body` on non-highlights should assert its
  // presence based on motivation rather than treat it as guaranteed.
  body?: Annotation['body'];
  creator: components['schemas']['Agent'];
  // The AUTHORING moment, carried from the event. A store must persist this
  // value rather than stamp its own clock: `rebuildResource` deletes and
  // replays, so a store that restamps collapses every annotation's `created`
  // to the rebuild moment on every reconcile heal.
  created: Annotation['created'];
}
