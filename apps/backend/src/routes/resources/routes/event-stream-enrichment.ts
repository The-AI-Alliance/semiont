/**
 * Helpers for enriching domain events emitted by the resource events-stream.
 *
 * The events-stream's wire format is `EnrichedResourceEvent`: a StoredEvent
 * with optional fields (currently `annotation`) populated from the materialized
 * view at SSE-write time. Subscribers can read those fields directly to update
 * local caches without refetching.
 *
 * These helpers are pure functions — no Hono request context, no SSE machinery
 * — so they can be unit-tested in isolation.
 */

import { AnnotationContext } from '@semiont/make-meaning';
import type { KnowledgeBase } from '@semiont/make-meaning';
import type { ResourceId, StoredEvent, components } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

/**
 * Read the post-mutation state of an annotation from the materialized view.
 *
 * Returns the annotation, or null if not present in the view (which after a
 * successful appendEvent indicates a real materialization bug — callers
 * should surface that as a failure rather than silently dropping).
 */
export async function readAnnotationFromView(
  kb: KnowledgeBase,
  resourceId: ResourceId,
  annotationId: string,
): Promise<Annotation | null> {
  const allAnnotations = await AnnotationContext.getAllAnnotations(resourceId, kb);
  return allAnnotations.find((a) => a.id === annotationId) ?? null;
}

/**
 * For events that mutate a single annotation, return that annotation's id.
 * For events that don't, return null.
 *
 * Discriminated switch on `event.type` so each branch knows the payload shape
 * exactly — no `as any` casts. If a future event type also mutates an
 * annotation, add a case here and the events-stream enrichment picks it up
 * automatically.
 */
export function eventAnnotationId(event: StoredEvent): string | null {
  switch (event.type) {
    case 'mark:added':
      // payload is { annotation: Annotation }
      return event.payload.annotation.id;
    case 'mark:body-updated':
      // payload is { annotationId: string, operations: ... }
      return event.payload.annotationId;
    case 'mark:removed':
      // payload is { annotationId: string }
      return event.payload.annotationId;
    default:
      return null;
  }
}
