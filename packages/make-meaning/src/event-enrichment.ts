import { AnnotationContext } from './annotation-context';
import type { EventStore, ViewStorage } from '@semiont/event-sourcing';
import type { Annotation, ResourceId, StoredEvent } from '@semiont/core';

export function eventAnnotationId(event: StoredEvent): string | null {
  switch (event.type) {
    case 'mark:added':
      return event.payload.annotation.id;
    case 'mark:body-updated':
      return event.payload.annotationId;
    case 'mark:removed':
      return event.payload.annotationId;
    default:
      return null;
  }
}

export async function readAnnotationFromView(
  kb: { views: Pick<ViewStorage, 'get'> },
  resourceId: ResourceId,
  annotationId: string,
): Promise<Annotation | null> {
  const allAnnotations = await AnnotationContext.getAllAnnotations(resourceId, kb);
  return allAnnotations.find((a) => a.id === annotationId) ?? null;
}

/**
 * Wire annotation enrichment onto an event store's append path. Enrichment
 * rides appendEvent (step 3 of its pipeline), so it belongs wherever appends
 * happen — the standalone root and the Archivist service, never the gateway
 * (EXTRACT-ARCHIVIST P3).
 */
export function wireEnrichment(eventStore: EventStore, kb: { views: Pick<ViewStorage, 'get'> }): void {
  eventStore.setEnrichEvent(async (event, resourceId) => {
    const annId = eventAnnotationId(event);
    if (annId === null) return event;
    const annotation = await readAnnotationFromView(kb, resourceId, annId);
    if (annotation === null) return event;
    return { ...event, annotation } as unknown as typeof event;
  });
}
