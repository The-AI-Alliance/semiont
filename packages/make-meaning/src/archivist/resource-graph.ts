/**
 * Assemble a resource's JSON-LD metadata graph — descriptor + annotations +
 * inbound entity references — from the event store.
 *
 * The Browser answers `browse:resource-requested` with it, and the HTTP
 * `/resources/:id/jsonld` face asks the Browser, so both return one shape.
 */

import type { Annotation, ResourceDescriptor, ResourceId } from '@semiont/core';
import { EventQuery } from '@semiont/event-sourcing';
import { getEntityTypes } from '@semiont/ontology';
import type { EventStoreReads } from './record-slices';

/**
 * `GetResourceResponse` with the domain-flavored (branded) documents the
 * materialized views actually hold — the same shape the branded
 * `browse:resource-result` reply declares (bus-protocol.ts). The raw OpenAPI
 * flavor exists only at the HTTP boundary (annotation-types.ts).
 */
export interface ResourceGraph {
  resource: ResourceDescriptor;
  annotations: Annotation[];
  entityReferences: Annotation[];
}

export async function assembleResourceGraph(
  kb: { eventStore: EventStoreReads },
  resourceId: ResourceId,
): Promise<ResourceGraph | null> {
  // Materialize from the event store (matches the get-uri.ts JSON-LD path).
  const eventQuery = new EventQuery(kb.eventStore.log.storage);
  const events = await eventQuery.getResourceEvents(resourceId);
  const stored = await kb.eventStore.views.materializer.materialize(events, resourceId);
  if (!stored) return null;

  const annotations = stored.annotations.annotations;
  const entityReferences = annotations.filter((a: Annotation) => {
    if (a.motivation !== 'linking') return false;
    return getEntityTypes({ body: a.body }).length > 0;
  });

  return { resource: stored.resource, annotations, entityReferences };
}
