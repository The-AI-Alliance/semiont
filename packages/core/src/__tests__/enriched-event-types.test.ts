/**
 * Type-level guard — the annotation channels carry their enrichment, typed.
 *
 * The EventStore's enrich step adds the annotation as it stands in the view to
 * every event that mutates one (make-meaning `wireEnrichment`), and the spec's
 * `EnrichedResourceEvent` tells subscribers to read it. `EventMap` must say the
 * same, or the producer and the consumer each cast across the gap and a rename
 * on either side fails silently on the other. Enforced by `tsc --noEmit`.
 */
import { describe, it, expect } from 'vitest';
import type { EventMap } from '../bus-protocol';
import type { Annotation } from '../annotation-types';
import { annotationId, resourceId, userId } from '../identifiers';

const envelope = {
  id: 'evt-1',
  timestamp: '2026-01-01T00:00:00Z',
  version: 1,
  resourceId: resourceId('res-1'),
  userId: userId('did:web:example.com:users:alice'),
  metadata: { sequenceNumber: 1 },
};

const annotation: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId('ann-1'),
  motivation: 'commenting',
  target: { source: 'res-1', selector: { type: 'TextQuoteSelector', exact: 'quoted' } },
  created: '2026-01-01T00:00:00Z',
};

describe('EventMap — the channels the EventStore enriches', () => {
  it('each annotation-mutating channel may carry the enriched annotation, branded', () => {
    const added: EventMap['mark:added'] = { ...envelope, type: 'mark:added', payload: { annotation }, annotation };
    const updated: EventMap['mark:body-updated'] = {
      ...envelope, type: 'mark:body-updated', payload: { annotationId: annotation.id, operations: [] }, annotation,
    };
    const removed: EventMap['mark:removed'] = {
      ...envelope, type: 'mark:removed', payload: { annotationId: annotation.id }, annotation,
    };
    expect([added, updated, removed].map((e) => e.annotation?.id)).toEqual(['ann-1', 'ann-1', 'ann-1']);
  });

  it('enrichment is optional — the enricher declines when the view no longer holds the annotation', () => {
    const unenriched: EventMap['mark:removed'] = {
      ...envelope, type: 'mark:removed', payload: { annotationId: annotation.id },
    };
    expect(unenriched.annotation).toBeUndefined();
  });

  it('a channel the EventStore never enriches does not accept one', () => {
    const archived: EventMap['mark:archived'] = {
      ...envelope,
      type: 'mark:archived',
      payload: {},
      // @ts-expect-error — enrichment is exactly the channels that mutate an annotation
      annotation,
    };
    expect(archived.type).toBe('mark:archived');
  });
});
