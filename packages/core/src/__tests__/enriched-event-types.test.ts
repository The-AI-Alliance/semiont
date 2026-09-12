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
import type { EventMap, EnrichedEventType } from '../bus-protocol';
import type { PersistedEventType } from '../persisted-events';
import { ENRICHED_EVENT_TYPES } from '../bus-protocol';
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
    expect([added, updated].map((e) => e.annotation?.id)).toEqual(['ann-1', 'ann-1']);
  });

  it('a REMOVAL is not enriched — the view no longer holds the annotation to attach', () => {
    // `enriched` means "the published event carries the annotation when the view
    // holds it". For a removal the view never does, so the flag promised
    // something the enricher could not deliver: consumers reading `.annotation`
    // got `undefined` at runtime while the type said it might be there. Now the
    // type says what the wire always did.
    const removed: EventMap['mark:removed'] = {
      ...envelope,
      type: 'mark:removed',
      payload: { annotationId: annotation.id },
      // @ts-expect-error — a removal carries no annotation
      annotation,
    };
    expect(removed.type).toBe('mark:removed');
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

/**
 * The generated list against the generated `EventMap`, derived two different
 * ways from one flag.
 *
 * `ENRICHED_EVENT_TYPES` comes from the registry's `enriched` flags; `ByKey`
 * comes from which channels' generated types actually carry `annotation`. They
 * agree only if the generator's filter reads the field it thinks it reads — so
 * this catches a generator bug that no behavioral test could, because a wrongly
 * filtered list still compiles and still dispatches, just over the wrong set.
 */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Narrowed to `PersistedEventType`, and that is not tidiness — over all of
 * `EventMap` this catches `mark:create` and `stream-connected`, two channels
 * whose own payload type happens to have an `annotation` key. They are a command
 * and a stream signal, not enriched stored events.
 *
 * The narrowing mirrors what `validate-registry.mjs` already enforces: the
 * `enriched` flag is only allowed on a stored event. Without it this test would
 * fail against a correct generator.
 */
type ByKey = {
  [K in PersistedEventType]: 'annotation' extends keyof EventMap[K] ? K : never
}[PersistedEventType];

describe('ENRICHED_EVENT_TYPES', () => {
  it('is exactly the channels whose EventMap type carries an annotation', () => {
    const agree: Equal<EnrichedEventType, ByKey> = true;
    expect(agree).toBe(true);
  });

  it('holds no duplicates', () => {
    // Every generated list joins the cross-list census. A repeat collapses in
    // the `[number]` union, so the TYPE cannot catch it.
    const dups = ENRICHED_EVENT_TYPES.filter((c, i) => ENRICHED_EVENT_TYPES.indexOf(c) !== i);
    expect(dups).toEqual([]);
  });

  it('no longer contains mark:removed', () => {
    expect(ENRICHED_EVENT_TYPES).not.toContain('mark:removed');
  });
});
