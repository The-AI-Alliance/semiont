/**
 * `wireEnrichment` — the annotation the EventStore publishes on the channels
 * that mutate one.
 *
 * Driven through a REAL EventStore — append, materialize, enrich, publish —
 * because the ordering is the contract. A body update must carry the
 * annotation AFTER the update, and a removal must go out unenriched; both hold
 * only because enrichment reads the view once it has been materialized, which
 * a test over a stubbed view could not tell apart. The SDK updates its
 * annotation cache in place from exactly this field, so a regression here is
 * a stale screen, not a failed request.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { EventBus, annotationId, resourceId, userId, type Annotation, type EventMap } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { wireEnrichment } from '../event-enrichment';
import { createTestProject, type TestProject } from './helpers/test-project';
import { mockLogger } from './helpers/smelter-harness';

const RID = resourceId('res-enrich');
const USER = userId('did:web:example.com:users:alice');

const annotation: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId('ann-enrich'),
  motivation: 'commenting',
  target: { source: RID, selector: { type: 'TextQuoteSelector', exact: 'quoted' } },
  body: [{ type: 'TextualBody', value: 'before', purpose: 'commenting' }],
  created: '2026-01-01T00:00:00Z',
};

describe('wireEnrichment — what the EventStore publishes on the annotation channels', () => {
  let test: TestProject;
  let eventBus: EventBus;
  let eventStore: EventStore;

  beforeEach(async () => {
    test = await createTestProject('enrichment');
    eventBus = new EventBus();
    eventStore = createEventStore(test.project, eventBus, mockLogger);
    wireEnrichment(eventStore, { views: eventStore.viewStorage });
    await eventStore.appendEvent({
      type: 'yield:created', resourceId: RID, userId: USER, version: 1,
      payload: { name: 'Enriched', format: 'text/plain', contentChecksum: 'h1' },
    });
  });

  afterEach(async () => {
    await test.teardown();
  });

  /** The next event published on `channel` — subscribe before appending. */
  const nextOn = <K extends keyof EventMap>(channel: K): Promise<EventMap[K]> =>
    firstValueFrom(eventBus.get(channel));

  const addAnnotation = () =>
    eventStore.appendEvent({ type: 'mark:added', resourceId: RID, userId: USER, version: 1, payload: { annotation } });

  it('mark:added goes out carrying the annotation as the view holds it', async () => {
    const published = nextOn('mark:added');
    await addAnnotation();

    expect((await published).annotation?.id).toBe('ann-enrich');
  });

  it('mark:body-updated carries the annotation AFTER the update — the new body, not the old', async () => {
    await addAnnotation();
    const published = nextOn('mark:body-updated');
    await eventStore.appendEvent({
      type: 'mark:body-updated', resourceId: RID, userId: USER, version: 1,
      payload: {
        annotationId: annotation.id,
        operations: [{ op: 'add', item: { type: 'TextualBody', value: 'after', purpose: 'commenting' } }],
      },
    });

    expect((await published).annotation?.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'after' })]),
    );
  });

  it('mark:removed goes out unenriched — it is not an enriched channel', async () => {
    // The behaviour is unchanged; only its reason is. This used to read "the
    // view no longer holds the annotation", which was true but described a
    // runtime accident: the channel WAS flagged `enriched`, so the type promised
    // an annotation the enricher could never attach. The flag is gone, so the
    // absence is now declared rather than incidental — and reading `.annotation`
    // here no longer compiles, which is why this asserts the key's absence the
    // way its unenriched sibling below does.
    await addAnnotation();
    const published = nextOn('mark:removed');
    await eventStore.appendEvent({
      type: 'mark:removed', resourceId: RID, userId: USER, version: 1,
      payload: { annotationId: annotation.id },
    });

    expect('annotation' in (await published)).toBe(false);
  });

  it('an event that touches no annotation goes out as it was stored', async () => {
    const published = nextOn('mark:archived');
    await eventStore.appendEvent({ type: 'mark:archived', resourceId: RID, userId: USER, version: 1, payload: {} });

    expect('annotation' in (await published)).toBe(false);
  });
});
