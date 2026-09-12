import { AnnotationContext } from './annotation-context';
import type { EventStore, ViewStorage } from '@semiont/event-sourcing';
import { ENRICHED_EVENT_TYPES } from '@semiont/core';
import type { Annotation, EnrichedEvent, EnrichedEventType, EventMap, ResourceId, StoredEvent } from '@semiont/core';

/**
 * The registry's `enriched` flags, as a runtime gate — generated, never a second
 * list. Both this set and the type the predicate narrows to come from
 * `ENRICHED_EVENT_TYPES`, so they cannot disagree; that is what makes the
 * unchecked predicate below safe.
 */
const ENRICHED = new Set<string>(ENRICHED_EVENT_TYPES);

function isEnriched(event: StoredEvent): event is StoredEvent & EventMap[EnrichedEventType] {
  return ENRICHED.has(event.type);
}

function eventAnnotationId(event: StoredEvent): string | null {
  // Unenriched channels leave before the switch, exactly as the old
  // `default: return null` did — but that default was also where a FLAGGED
  // channel with no case landed, silently, forever. Consumers could not detect
  // it: `annotation` is optional, so a never-attached annotation is
  // indistinguishable from a genuine decline.
  if (!isEnriched(event)) return null;

  switch (event.type) {
    case 'mark:added':
      return event.payload.annotation.id;
    case 'mark:body-updated':
      return event.payload.annotationId;
    default: {
      // The gate: flag a channel without adding a case and this assignment stops
      // compiling; unflag one that has a case and its `case` stops compiling
      // (TS2678). The registry and this switch cannot drift in either direction.
      //
      // Compile-time only — it returns `null` rather than throwing, so the
      // runtime behaviour of an unknown channel is exactly today's. A throw here
      // would put a programming error on the publish path.
      const unreachable: never = event;
      void unreachable;
      return null;
    }
  }
}

async function readAnnotationFromView(
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
    return { ...event, annotation } satisfies EnrichedEvent;
  });
}
