import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BehaviorSubject, firstValueFrom, filter } from 'rxjs';
import { EventBus, resourceId, annotationId } from '@semiont/core';
import { BrowseNamespace } from '../browse';
import type { ITransport, IContentTransport } from '@semiont/core';

import type { Annotation } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';

function stored(event: Record<string, any>): any {
  return { ...event, metadata: { sequenceNumber: 1, streamPosition: 0 } };
}

function mockAnnotation(id: string): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(id),
    motivation: 'commenting',
    created: '2026-01-01T00:00:00Z',
    target: { source: 'res-1' },
    body: [{ type: 'TextualBody', value: 'test comment', purpose: 'commenting' }],
  };
}

function mockResource(id: string): ResourceDescriptor {
  return { '@context': 'http://schema.org', '@id': resourceId(id), name: `Resource ${id}`, representations: [] };
}

type ResponseMap = Record<string, (payload: Record<string, unknown>) => { resultChannel: string; response: Record<string, unknown> }>;

function createMockTransport(responses: ResponseMap): { transport: ITransport; emitSpy: ReturnType<typeof vi.fn> } {
  const transportBus = new EventBus();
  const emitSpy = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
    const handler = responses[channel];
    if (handler) {
      const { resultChannel, response } = handler(payload);
      const correlationId = payload.correlationId as string;
      queueMicrotask(() => {
        (transportBus.get(resultChannel as never) as { next(v: unknown): void }).next({ correlationId, response });
      });
    }
  });

  const transport = {
    emit: emitSpy,
    on: <K extends never>(channel: K, handler: (p: never) => void) => {
      const sub = (transportBus.get(channel) as { subscribe(fn: (p: never) => void): { unsubscribe(): void } }).subscribe(handler);
      return () => sub.unsubscribe();
    },
    stream: <K extends never>(channel: K) => transportBus.get(channel),
    subscribeToResource: vi.fn().mockReturnValue(() => {}),
    bridgeInto: vi.fn(),
    state$: new BehaviorSubject<'connected'>('connected').asObservable() as never,
    dispose: vi.fn(),
  } as unknown as ITransport;

  return { transport, emitSpy };
}

function defaultResponses(): ResponseMap {
  return {
    'browse:annotations-requested': () => ({
      resultChannel: 'browse:annotations-result',
      response: { annotations: [mockAnnotation('ann-1')], total: 1 },
    }),
    'browse:annotation-requested': () => ({
      resultChannel: 'browse:annotation-result',
      response: { annotation: mockAnnotation('ann-1'), resource: null, resolvedResource: null },
    }),
    'browse:resource-requested': () => ({
      resultChannel: 'browse:resource-result',
      response: { resource: mockResource('res-1'), annotations: [], entityReferences: [] },
    }),
    'browse:resources-requested': () => ({
      resultChannel: 'browse:resources-result',
      response: { resources: [mockResource('res-1')], total: 1, offset: 0, limit: 20 },
    }),
    'browse:referenced-by-requested': () => ({
      resultChannel: 'browse:referenced-by-result',
      response: { referencedBy: [] },
    }),
    'browse:entity-types-requested': () => ({
      resultChannel: 'browse:entity-types-result',
      response: { entityTypes: ['Person'] },
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
    dispose: vi.fn(),
  };
}

function firstDefined<T>(obs: import('rxjs').Observable<T | undefined>): Promise<T> {
  return firstValueFrom(obs.pipe(filter((v): v is T => v !== undefined)));
}

describe('BrowseNamespace', () => {
  let eventBus: EventBus;
  let content: IContentTransport;
  let browse: BrowseNamespace;
  let emitSpy: ReturnType<typeof vi.fn>;
  const RID = resourceId('res-1');
  const AID = annotationId('ann-1');

  beforeEach(() => {
    eventBus = new EventBus();
    content = makeContent();
    const mock = createMockTransport(defaultResponses());
    emitSpy = mock.emitSpy;
    browse = new BrowseNamespace(mock.transport, eventBus, content);
  });

  // ── Annotation caching ────────────────────────────────────────────────

  describe('annotations()', () => {
    it('fetches on first subscribe', async () => {
      const val = await firstDefined(browse.annotations(RID));
      expect(emitSpy).toHaveBeenCalledWith('browse:annotations-requested', expect.objectContaining({ resourceId: RID }));
      expect(val).toHaveLength(1);
    });

    it('caches (no second fetch)', async () => {
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.annotations(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
    });

    it('does not issue duplicate in-flight requests', () => {
      browse.annotations(RID).subscribe(() => {});
      browse.annotations(RID).subscribe(() => {});
      expect(emitSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('annotation()', () => {
    it('fetches on first subscribe', async () => {
      const val = await firstDefined(browse.annotation(RID, AID));
      expect(emitSpy).toHaveBeenCalledWith('browse:annotation-requested', expect.objectContaining({ annotationId: AID }));
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
      expect(emitSpy).toHaveBeenCalledWith('browse:resource-requested', expect.objectContaining({ resourceId: RID }));
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
      expect(val).toHaveLength(1);
    });

    it('uses separate cache keys for different filters', async () => {
      await firstDefined(browse.resources({ limit: 10 }));
      await firstDefined(browse.resources({ limit: 20 }));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('caches the same query and re-fetches a different one', async () => {
      await firstDefined(browse.resources({ search: 'foo' }));
      await firstDefined(browse.resources({ search: 'foo' }));
      expect(emitSpy).toHaveBeenCalledTimes(1);

      await firstDefined(browse.resources({ search: 'bar' }));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── Entity types ──────────────────────────────────────────────────────

  describe('entityTypes()', () => {
    it('fetches on first subscribe', async () => {
      const val = await firstDefined(browse.entityTypes());
      expect(emitSpy).toHaveBeenCalledWith('browse:entity-types-requested', expect.any(Object));
      expect(val).toEqual(['Person']);
    });
  });

  // ── Invalidation ──────────────────────────────────────────────────────

  describe('invalidateAnnotationList()', () => {
    it('triggers re-fetch', async () => {
      await firstDefined(browse.annotations(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
      browse.invalidateAnnotationList(RID);
      await firstDefined(browse.annotations(RID));
      expect(emitSpy).toHaveBeenCalledTimes(2);
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
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect((list![0].body as any[])[0]).toMatchObject({ source: 'res-2' });
    });

    it('appends a new annotation if not present', async () => {
      await firstDefined(browse.annotations(RID));
      browse.updateAnnotationInPlace(RID, withBody('ann-2', 'res-3'));
      const list = await firstDefined(browse.annotations(RID));
      expect(list).toHaveLength(2);
    });

    it('is a no-op when list is not cached', () => {
      browse.updateAnnotationInPlace(RID, withBody('ann-1', 'res-2'));
      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  // ── EventBus reactions (annotation) ───────────────────────────────────

  describe('EventBus → annotation cache', () => {
    it('mark:delete-ok → removes from detail cache', async () => {
      await firstDefined(browse.annotation(RID, AID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.get('mark:delete-ok').next({ annotationId: AID } as any);
      await firstDefined(browse.annotation(RID, AID));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('mark:added → invalidates list + events', async () => {
      await firstDefined(browse.annotations(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.get('mark:added').next(stored({ resourceId: RID }) as any);
      await firstDefined(browse.annotations(RID));
      // annotations refetch + events refetch = 2 additional emits
      expect(emitSpy).toHaveBeenCalledTimes(3);
    });

    it('mark:removed → invalidates list + events', async () => {
      await firstDefined(browse.annotations(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.get('mark:removed').next(stored({ resourceId: RID, payload: { annotationId: AID } }) as any);
      await firstDefined(browse.annotations(RID));
      // annotations refetch + events refetch = 2 additional emits
      expect(emitSpy).toHaveBeenCalledTimes(3);
    });

    it('mark:body-updated (enriched) → in-place update + events refetch', async () => {
      await firstDefined(browse.annotations(RID));
      const updated = { ...mockAnnotation('ann-1'), body: [{ type: 'SpecificResource', source: 'res-target', purpose: 'linking' }] } as Annotation;
      eventBus.get('mark:body-updated').next(stored({ resourceId: RID, payload: { annotationId: AID }, annotation: updated }) as any);
      const list = await firstDefined(browse.annotations(RID));
      // annotations not refetched (in-place update), but events refetched
      expect(emitSpy).toHaveBeenCalledTimes(2);
      expect((list![0].body as any[])[0]).toMatchObject({ source: 'res-target' });
    });

    it('mark:body-updated without annotation → no-op', async () => {
      await firstDefined(browse.annotations(RID));
      eventBus.get('mark:body-updated').next(stored({ resourceId: RID, payload: { annotationId: AID } }) as any);
      expect(emitSpy).toHaveBeenCalledTimes(1);
    });

    it('mark:entity-tag-added → invalidates annotation list + resource detail', async () => {
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.resource(RID));
      eventBus.get('mark:entity-tag-added').next(stored({ resourceId: RID }) as any);
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(5);
    });

    it('replay-window-exceeded → invalidates annotation list', async () => {
      await firstDefined(browse.annotations(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.get('replay-window-exceeded').next({ resourceId: 'res-1', lastEventId: 1, missedCount: 5000, cap: 1000, message: 'exceeded' });
      await firstDefined(browse.annotations(RID));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── EventBus reactions (resource) ─────────────────────────────────────

  describe('EventBus → resource cache', () => {
    it('yield:create-ok → fetches new resource, invalidates lists', async () => {
      await firstDefined(browse.resources());
      eventBus.get('yield:create-ok').next({ resourceId: RID, resource: mockResource('res-1') as any });
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledWith('browse:resource-requested', expect.objectContaining({ resourceId: RID }));
    });

    it('mark:archived → invalidates resource detail + lists', async () => {
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.get('mark:archived').next(stored({ resourceId: RID }) as any);
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('mark:unarchived → invalidates resource detail + lists', async () => {
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.get('mark:unarchived').next(stored({ resourceId: RID }) as any);
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('mark:entity-type-added → invalidates entity types', async () => {
      await firstDefined(browse.entityTypes());
      expect(emitSpy).toHaveBeenCalledTimes(1);
      eventBus.get('mark:entity-type-added').next(stored({}) as any);
      await firstDefined(browse.entityTypes());
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });
  });
});
