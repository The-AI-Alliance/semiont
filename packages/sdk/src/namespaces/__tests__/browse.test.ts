import { describe, it, expect, beforeEach, vi } from 'vitest';
import { map, firstValueFrom, filter, BehaviorSubject } from 'rxjs';
import { EventBus, resourceId, annotationId, userId } from '@semiont/core';
import { BrowseNamespace } from '../browse';
import { isReady } from '../../cache';
import type { AnchoredTextAnswer, ConnectionState, ITransport, IContentTransport } from '@semiont/core';

import type { Annotation } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';
import { inMemoryTransport } from '../../__tests__/helpers/in-memory-transport';

/** What every stored event carries beside its type, resource and payload. */
const STORED = {
  id: 'evt-1',
  userId: userId('did:web:test:users:test'),
  version: 1,
  timestamp: '2026-01-01T00:00:00Z',
  metadata: { sequenceNumber: 1 },
};

function mockAnnotation(id: string): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(id),
    motivation: 'commenting',
    created: '2026-01-01T00:00:00Z',
    target: { source: resourceId('res-1') },
    body: [{ type: 'TextualBody', value: 'test comment', purpose: 'commenting' }],
  };
}

function mockResource(id: string): ResourceDescriptor {
  return { '@context': 'http://schema.org', '@id': resourceId(id), name: `Resource ${id}`, representations: [] };
}

type ResponseMap = Record<string, (payload: Record<string, unknown>) => { resultChannel: string; response: Record<string, unknown> }>;

function createMockTransport(responses: ResponseMap): { transport: ITransport; emitSpy: ReturnType<typeof vi.fn>; state$: BehaviorSubject<ConnectionState> } {
  const transportBus = new EventBus();
  const state$ = new BehaviorSubject<ConnectionState>('open');
  const emitSpy = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>, envelope?: { correlationId?: string }) => {
    const handler = responses[channel];
    if (handler) {
      const { resultChannel, response } = handler(payload);
      const correlationId = envelope?.correlationId as string;
      queueMicrotask(() => {
        transportBus.emit(resultChannel as never, { response } as never, { correlationId });
      });
    }
  });

  const transport: ITransport = {
    ...inMemoryTransport({
      bus: transportBus,
      onEmit: (channel, payload, envelope) => { void emitSpy(channel, payload, envelope); },
      state$,
    }),
  };

  return { transport, emitSpy, state$ };
}

function defaultResponses(): ResponseMap {
  return {
    'browse:annotation-requested': () => ({
      resultChannel: 'browse:annotation-result',
      response: { annotation: mockAnnotation('ann-1'), resource: null, resolvedResource: null },
    }),
    'browse:resource-requested': () => ({
      resultChannel: 'browse:resource-result',
      response: { resource: mockResource('res-1'), lastSequence: 1 },
    }),
    'browse:resources-requested': () => ({
      resultChannel: 'browse:resources-result',
      response: { resources: [mockResource('res-1')], total: 1, offset: 0, limit: 20 },
    }),
    'browse:entity-types-requested': () => ({
      resultChannel: 'browse:entity-types-result',
      response: { entityTypes: ['Person'] },
    }),
    'browse:tag-schemas-requested': () => ({
      resultChannel: 'browse:tag-schemas-result',
      response: {
        tagSchemas: [
          {
            id: 'test-schema',
            name: 'Test Schema',
            description: 'Schema for browse.test.ts',
            domain: 'test',
            tags: [{ name: 'A', description: 'cat A', examples: [] }],
          },
        ],
      },
    }),
    'browse:events-requested': () => ({
      resultChannel: 'browse:events-result',
      response: { events: [], total: 0, resourceId: 'res-1' },
    }),
    'browse:annotation-history-requested': () => ({
      resultChannel: 'browse:annotation-history-result',
      response: { events: [], total: 0 },
    }),
    'browse:directory-requested': () => ({
      resultChannel: 'browse:directory-result',
      response: { files: [] },
    }),
  };
}

function makeContent(): IContentTransport {
  return {
    putBinary: vi.fn(),
    getBinary: vi.fn().mockResolvedValue({ data: new ArrayBuffer(0), contentType: 'text/plain' }),
    getBinaryStream: vi.fn().mockResolvedValue({ stream: new ReadableStream(), contentType: 'text/plain' }),
    getResourceGraph: vi.fn(),
    getAnnotations: vi.fn().mockResolvedValue({ annotations: [mockAnnotation('ann-1')], total: 1 }),
    getAnchoredText: vi.fn(),
    dispose: vi.fn(),
  };
}

function firstDefined<T>(obs: import('rxjs').Observable<import('../../cache').CacheState<T>>): Promise<T> {
  return firstValueFrom(obs.pipe(filter(isReady), map((s) => s.value)));
}

describe('BrowseNamespace', () => {
  let eventBus: EventBus;
  let content: IContentTransport;
  let browse: BrowseNamespace;
  let emitSpy: ReturnType<typeof vi.fn>;
  let state$: BehaviorSubject<ConnectionState>;
  const RID = resourceId('res-1');
  const AID = annotationId('ann-1');

  beforeEach(() => {
    eventBus = new EventBus();
    content = makeContent();
    const mock = createMockTransport(defaultResponses());
    emitSpy = mock.emitSpy;
    state$ = mock.state$;
    browse = new BrowseNamespace(mock.transport, eventBus, content);
  });

  // ── Annotation caching ────────────────────────────────────────────────

  describe('annotations()', () => {
    it('fetches on first subscribe, from the content transport and not the bus', async () => {
      const val = await firstDefined(browse.annotations(RID));
      expect(content.getAnnotations).toHaveBeenCalledWith(RID);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(val).toHaveLength(1);
    });

    it('caches (no second fetch)', async () => {
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.annotations(RID));
      expect(content.getAnnotations).toHaveBeenCalledTimes(1);
    });

    it('does not issue duplicate in-flight requests', () => {
      browse.annotations(RID).subscribe(() => {});
      browse.annotations(RID).subscribe(() => {});
      expect(content.getAnnotations).toHaveBeenCalledTimes(1);
    });
  });

  describe('annotation()', () => {
    it('fetches on first subscribe', async () => {
      const val = await firstDefined(browse.annotation(RID, AID));
      expect(emitSpy).toHaveBeenCalledWith('browse:annotation-requested', expect.objectContaining({ annotationId: AID }), expect.objectContaining({ correlationId: expect.any(String) }));
      expect(val).toBeDefined();
    });

    it('caches the result', async () => {
      await firstDefined(browse.annotation(RID, AID));
      await firstDefined(browse.annotation(RID, AID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Resource caching ──────────────────────────────────────────────────

  describe('resource()', () => {
    it('fetches on first subscribe', async () => {
      const val = await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledWith('browse:resource-requested', expect.objectContaining({ resourceId: RID }), expect.objectContaining({ correlationId: expect.any(String) }));
      expect(val).toMatchObject({ name: 'Resource res-1' });
    });

    it('caches (no second fetch)', async () => {
      await firstDefined(browse.resource(RID));
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('resources()', () => {
    it('fetches on first subscribe', async () => {
      const val = await firstDefined(browse.resources());
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(val.resources).toHaveLength(1);
    });

    it('uses separate cache keys for different filters', async () => {
      await firstDefined(browse.resources({ limit: 10 }));
      await firstDefined(browse.resources({ limit: 20 }));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('caches the same query and re-fetches a different one', async () => {
      await firstDefined(browse.resources({ entityType: 'Person' }));
      await firstDefined(browse.resources({ entityType: 'Person' }));
      expect(emitSpy).toHaveBeenCalledTimes(1);

      await firstDefined(browse.resources({ entityType: 'Place' }));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── Entity types ──────────────────────────────────────────────────────

  // ── Anchored text through the content transport ───────────────────────
  // An anchored text is as large as its document, and bytes do not ride the
  // bus: the read is the content transport's, and the answer is what it gave.

  it('resourceAnchoredText asks the content transport, and puts nothing on the bus', async () => {
    const ANSWER: AnchoredTextAnswer = { kind: 'extracted', text: 'hello', method: 'pdf-text-layer', items: [] };
    const mock = createMockTransport(defaultResponses());
    const getAnchoredText = vi.fn<IContentTransport['getAnchoredText']>().mockResolvedValue(ANSWER);
    const b = new BrowseNamespace(mock.transport, new EventBus(), { ...makeContent(), getAnchoredText });

    await expect(b.resourceAnchoredText(RID)).resolves.toBe(ANSWER);

    expect(getAnchoredText).toHaveBeenCalledWith(RID);
    expect(mock.emitSpy).not.toHaveBeenCalled();
  });

  it('kb() asks on every call: a branch changes with no event to invalidate a kept answer', async () => {
    let gitBranch = 'main';
    const responses = defaultResponses();
    responses['browse:kb-requested'] = () => ({
      resultChannel: 'browse:kb-result',
      response: { name: 'KB', domain: 'example.github.io:kb', gitBranch },
    });
    const mock = createMockTransport(responses);
    const b = new BrowseNamespace(mock.transport, new EventBus(), makeContent());

    await expect(b.kb()).resolves.toEqual({ name: 'KB', domain: 'example.github.io:kb', gitBranch: 'main' });
    gitBranch = 'second-line';
    await expect(b.kb()).resolves.toMatchObject({ gitBranch: 'second-line' });

    expect(mock.emitSpy.mock.calls.filter(([channel]) => channel === 'browse:kb-requested')).toHaveLength(2);
  });

  describe('entityTypes()', () => {
    it('fetches on first subscribe', async () => {
      const val = await firstDefined(browse.entityTypes());
      expect(emitSpy).toHaveBeenCalledWith('browse:entity-types-requested', expect.any(Object), expect.objectContaining({ correlationId: expect.any(String) }));
      expect(val).toEqual(['Person']);
    });
  });

  // ── Tag schemas ───────────────────────────────────────────────────────

  describe('tagSchemas()', () => {
    it('fetches on first subscribe', async () => {
      const val = await firstDefined(browse.tagSchemas());
      expect(emitSpy).toHaveBeenCalledWith('browse:tag-schemas-requested', expect.any(Object), expect.objectContaining({ correlationId: expect.any(String) }));
      expect(val).toHaveLength(1);
      expect(val[0]?.id).toBe('test-schema');
    });

    it('caches (no second fetch)', async () => {
      await firstDefined(browse.tagSchemas());
      await firstDefined(browse.tagSchemas());
      expect(emitSpy).toHaveBeenCalledTimes(1);
    });

    it('returns the same observable on repeated calls (per-key stability)', () => {
      const obs1 = browse.tagSchemas();
      const obs2 = browse.tagSchemas();
      expect(obs1).toBe(obs2);
    });
  });

  // ── Invalidation ──────────────────────────────────────────────────────

  describe('invalidateAnnotationList()', () => {
    it('triggers re-fetch', async () => {
      await firstDefined(browse.annotations(RID));
      expect(content.getAnnotations).toHaveBeenCalledTimes(1);
      browse.invalidateAnnotationList(RID);
      await firstDefined(browse.annotations(RID));
      expect(content.getAnnotations).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateResourceDetail()', () => {
    it('triggers re-fetch', async () => {
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
      browse.invalidateResourceDetail(RID);
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── updateAnnotationInPlace ───────────────────────────────────────────

  describe('updateAnnotationInPlace()', () => {
    function withBody(id: string, source: string): Annotation {
      return { ...mockAnnotation(id), motivation: 'linking', body: [{ type: 'SpecificResource', source, purpose: 'linking' }] } as Annotation;
    }

    it('replaces an existing annotation in the cached list', async () => {
      await firstDefined(browse.annotations(RID));
      browse.updateAnnotationInPlace(RID, withBody('ann-1', 'res-2'));
      const list = await firstDefined(browse.annotations(RID));
      expect(content.getAnnotations).toHaveBeenCalledTimes(1);
      expect(list![0].body).toMatchObject([{ source: 'res-2' }]);
    });

    it('appends a new annotation if not present', async () => {
      await firstDefined(browse.annotations(RID));
      browse.updateAnnotationInPlace(RID, withBody('ann-2', 'res-3'));
      const list = await firstDefined(browse.annotations(RID));
      expect(list).toHaveLength(2);
    });

    it('is a no-op when list is not cached', () => {
      browse.updateAnnotationInPlace(RID, withBody('ann-1', 'res-2'));
      expect(content.getAnnotations).not.toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  // ── EventBus reactions (annotation) ───────────────────────────────────

  describe('EventBus → annotation cache', () => {
    it('mark:delete-ok → removes from detail cache', async () => {
      await firstDefined(browse.annotation(RID, AID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.emit('mark:delete-ok', { response: { annotationId: AID } });
      await firstDefined(browse.annotation(RID, AID));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    // Each observes what it counts: an event refreshes only the keys the
    // cache knows (B20).
    it('mark:added → invalidates list + events', async () => {
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.events(RID));
      expect(content.getAnnotations).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.emit('mark:added', { ...STORED, type: 'mark:added', resourceId: RID, payload: { annotation: mockAnnotation('ann-2') } });
      await firstDefined(browse.annotations(RID));
      expect(content.getAnnotations).toHaveBeenCalledTimes(2);
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('mark:removed → invalidates list + events', async () => {
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.events(RID));
      expect(content.getAnnotations).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.emit('mark:removed', { ...STORED, type: 'mark:removed', resourceId: RID, payload: { annotationId: AID } });
      await firstDefined(browse.annotations(RID));
      expect(content.getAnnotations).toHaveBeenCalledTimes(2);
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('mark:body-updated (enriched) → in-place update + events refetch', async () => {
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.events(RID));
      const updated = { ...mockAnnotation('ann-1'), body: [{ type: 'SpecificResource', source: 'res-target', purpose: 'linking' }] } as Annotation;
      eventBus.emit('mark:body-updated', { ...STORED, type: 'mark:body-updated', resourceId: RID, payload: { annotationId: AID, operations: [{ op: 'add', item: { type: 'SpecificResource', source: 'res-target', purpose: 'linking' } }] }, annotation: updated });
      const list = await firstDefined(browse.annotations(RID));
      // annotations not refetched (in-place update), but events refetched
      expect(content.getAnnotations).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledTimes(2);
      expect(list![0].body).toMatchObject([{ source: 'res-target' }]);
    });

    it('mark:body-updated without annotation → invalidates list + events (never keeps the stale body)', async () => {
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.events(RID));
      expect(content.getAnnotations).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      // Unenriched: the view did not hold the annotation when the EventStore
      // enriched the event, so there is nothing to write through. A no-op
      // here would leave the stale body on screen; B13c in
      // cache-semantics.test.ts is the contract clause.
      eventBus.emit('mark:body-updated', { ...STORED, type: 'mark:body-updated', resourceId: RID, payload: { annotationId: AID, operations: [{ op: 'add', item: { type: 'SpecificResource', source: 'res-target', purpose: 'linking' } }] } });
      await firstDefined(browse.annotations(RID));
      expect(content.getAnnotations).toHaveBeenCalledTimes(2);
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('mark:entity-tag-added → invalidates annotation list + resource detail + events', async () => {
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.resource(RID));
      await firstDefined(browse.events(RID));
      eventBus.emit('mark:entity-tag-added', { ...STORED, type: 'mark:entity-tag-added', resourceId: RID, payload: { entityType: 'Person' } });
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.resource(RID));
      expect(content.getAnnotations).toHaveBeenCalledTimes(2);
      // resource + events, each asked once and once again
      expect(emitSpy).toHaveBeenCalledTimes(4);
    });
  });

  // ── EventBus reactions (resource) ─────────────────────────────────────

  describe('EventBus → resource cache', () => {
    it('yield:create-ok → fetches new resource, invalidates lists', async () => {
      await firstDefined(browse.resources());
      eventBus.emit('yield:create-ok', { response: { resourceId: RID } });
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledWith('browse:resource-requested', expect.objectContaining({ resourceId: RID }), expect.objectContaining({ correlationId: expect.any(String) }));
    });

    // ── Resource events reach non-requesting clients ──────────────────
    // The gateway writes a correlated reply only to the client that made the
    // request, so `yield:*-ok` reaches ONLY that client and a reply cannot
    // double as a cross-client invalidation signal. The persisted domain
    // events carry that job instead — the `frame:entity-type-added`
    // precedent. These four cases are written from the NON-requester's seat:
    // nothing here emits a request.

    it('yield:created → a non-requesting client invalidates its list and detail', async () => {
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.emit('yield:created', { ...STORED, type: 'yield:created', resourceId: RID, payload: { name: 'Created', format: 'text/plain', contentChecksum: 'sha256-test' } });
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('yield:updated → a non-requesting client invalidates', async () => {
      await firstDefined(browse.resource(RID));
      eventBus.emit('yield:updated', { ...STORED, type: 'yield:updated', resourceId: RID, payload: { contentChecksum: 'sha256-test' } });
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('yield:cloned → invalidates — a clone created a resource nobody was told about', async () => {
      // Without this trigger a clone-persist creates a resource and no list
      // ever learns of it.
      await firstDefined(browse.resource(RID));
      eventBus.emit('yield:cloned', { ...STORED, type: 'yield:cloned', resourceId: RID, payload: { name: 'Cloned', format: 'text/plain', contentChecksum: 'sha256-test', parentResourceId: resourceId('res-parent') } });
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('yield:moved → invalidates — a rename went stale in every other list', async () => {
      await firstDefined(browse.resource(RID));
      eventBus.emit('yield:moved', { ...STORED, type: 'yield:moved', resourceId: RID, payload: { fromUri: 'file://old.md', toUri: 'file://new.md' } });
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('mark:archived → invalidates resource detail + lists', async () => {
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.emit('mark:archived', { ...STORED, type: 'mark:archived', resourceId: RID, payload: {} });
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('mark:unarchived → invalidates resource detail + lists', async () => {
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.emit('mark:unarchived', { ...STORED, type: 'mark:unarchived', resourceId: RID, payload: {} });
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('frame:entity-type-added → invalidates entity types', async () => {
      await firstDefined(browse.entityTypes());
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.emit('frame:entity-type-added', { ...STORED, type: 'frame:entity-type-added', payload: { entityType: 'Person' } });
      await firstDefined(browse.entityTypes());
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('frame:tag-schema-added → invalidates tag schemas', async () => {
      await firstDefined(browse.tagSchemas());
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.emit('frame:tag-schema-added', { ...STORED, type: 'frame:tag-schema-added', payload: { schema: { id: 'legal', name: 'Legal', description: 'Legal roles', domain: 'legal', tags: [] } } });
      await firstDefined(browse.tagSchemas());
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('the stream reopening after a drop → invalidates the KB-wide registries the cache knows', async () => {
      // Nothing replays what every client hears, so a drop is answered by
      // asking again, of each registry the cache knows (B20): here the two
      // that were observed, and not the collaborator directory, which
      // nothing asked for.
      const fetches = (channel: string) =>
        emitSpy.mock.calls.filter((call: unknown[]) => call[0] === channel).length;

      await firstDefined(browse.entityTypes());
      await firstDefined(browse.tagSchemas());
      expect(fetches('browse:entity-types-requested')).toBe(1);
      expect(fetches('browse:tag-schemas-requested')).toBe(1);

      state$.next('reconnecting');
      state$.next('connecting');
      state$.next('open');
      await firstDefined(browse.entityTypes());
      await firstDefined(browse.tagSchemas());
      expect(fetches('browse:entity-types-requested')).toBe(2);
      expect(fetches('browse:tag-schemas-requested')).toBe(2);
      expect(fetches('browse:agents-requested')).toBe(0);
    });

    it('the stream reopening fetches no registry nothing has asked for (B20)', async () => {
      state$.next('reconnecting');
      state$.next('connecting');
      state$.next('open');
      await new Promise((r) => setTimeout(r, 0));
      expect(emitSpy).not.toHaveBeenCalled();
    });
  });
});
