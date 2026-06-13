/**
 * Assemble a resource's JSON-LD metadata graph — descriptor + annotations +
 * inbound entity references — from the event store.
 *
 * Shared by the bus handler (`browse:resource-requested`, in `browser.ts`) and
 * `LocalContentTransport.getResourceGraph`, so the in-process face and the
 * HTTP `/resources/:id/jsonld` face return identical shapes.
 * See `.plans/SIMPLER-JSON-LD.md` (Phase 2, decision 7).
 */

import type { ResourceId, components } from '@semiont/core';
import { EventQuery } from '@semiont/event-sourcing';
import { getEntityTypes } from '@semiont/ontology';
import type { KnowledgeBase } from './knowledge-base';

type GetResourceResponse = components['schemas']['GetResourceResponse'];
type Annotation = components['schemas']['Annotation'];

export async function assembleResourceGraph(
  kb: KnowledgeBase,
  resourceId: ResourceId,
): Promise<GetResourceResponse | null> {
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
