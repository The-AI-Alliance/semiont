/**
 * BrowseNamespace tests
 *
 * Ports the deleted AnnotationStore + ResourceStore tests to the
 * unified BrowseNamespace. Tests lazy fetch, cache invalidation,
 * EventBus-driven updates, and in-place annotation updates.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { firstValueFrom, filter } from 'rxjs';
import { EventBus, resourceId, annotationId } from '@semiont/core';
import type { components } from '@semiont/core';
import { BrowseNamespace } from '../browse';
import type { SemiontApiClient } from '../../client';

type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

function stored(event: Record<string, any>): any {
  return { ...event, metadata: { sequenceNumber: 1, streamPosition: 0 } };
}

function mockAnnotation(id: string): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id,
    motivation: 'commenting',
    created: '2026-01-01T00:00:00Z',
    target: { source: 'res-1' },
    body: [],
  };
}

function mockResource(id: string): ResourceDescriptor {
  return { '@context': 'http://schema.org', '@id': id, name: `Resource ${id}`, representations: [] };
}

function makeHttp() {
  return {
    browseAnnotations: vi.fn().mockResolvedValue({ annotations: [mockAnnotation('ann-1')], total: 1 }),
    browseAnnotation: vi.fn().mockResolvedValue({ annotation: mockAnnotation('ann-1'), resource: null, resolvedResource: null }),
    browseResource: vi.fn().mockResolvedValue({ resource: mockResource('res-1'), annotations: [], entityReferences: [] }),
    browseResources: vi.fn().mockResolvedValue({ resources: [mockResource('res-1')], total: 1, offset: 0, limit: 20 }),
    browseReferences: vi.fn().mockResolvedValue({ referencedBy: [] }),
    listEntityTypes: vi.fn().mockResolvedValue({ entityTypes: ['Person'] }),
    getResourceRepresentation: vi.fn().mockResolvedValue({ data: new ArrayBuffer(0), contentType: 'text/plain' }),
    getResourceRepresentationStream: vi.fn().mockResolvedValue({ stream: new ReadableStream(), contentType: 'text/plain' }),
    getResourceEvents: vi.fn().mockResolvedValue({ events: [], total: 0, resourceId: 'res-1' }),
    getAnnotationHistory: vi.fn().mockResolvedValue({ events: [], total: 0 }),
    browseFiles: vi.fn().mockResolvedValue({ files: [] }),
  } as unknown as SemiontApiClient;
}

function firstDefined<T>(obs: import('rxjs').Observable<T | undefined>): Promise<T> {
  return firstValueFrom(obs.pipe(filter((v): v is T => v !== undefined)));
}

describe('BrowseNamespace', () => {
  let eventBus: EventBus;
  let http: SemiontApiClient;
  let browse: BrowseNamespace;
  const RID = resourceId('res-1');
  const AID = annotationId('ann-1');

  beforeEach(() => {
    eventBus = new EventBus();
    http = makeHttp();
    browse = new BrowseNamespace(http, eventBus, () => undefined);
  });

  // ── Annotation caching ────────────────────────────────────────────────

  describe('annotations()', () => {
    it('fetches on first subscribe', async () => {
      const val = await firstDefined(browse.annotations(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
      expect(val).toHaveLength(1);
    });

    it('caches (no second fetch)', async () => {
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.annotations(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
    });

    it('does not issue duplicate in-flight requests', () => {
      browse.annotations(RID).subscribe(() => {});
      browse.annotations(RID).subscribe(() => {});
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
    });
  });

  describe('annotation()', () => {
    it('fetches on first subscribe', async () => {
      const val = await firstDefined(browse.annotation(RID, AID));
      expect(http.browseAnnotation).toHaveBeenCalledTimes(1);
      expect(val).toBeDefined();
    });

    it('caches the result', async () => {
      await firstDefined(browse.annotation(RID, AID));
      await firstDefined(browse.annotation(RID, AID));
      expect(http.browseAnnotation).toHaveBeenCalledTimes(1);
    });
  });

  // ── Resource caching ──────────────────────────────────────────────────

  describe('resource()', () => {
    it('fetches on first subscribe', async () => {
      const val = await firstDefined(browse.resource(RID));
      expect(http.browseResource).toHaveBeenCalledTimes(1);
      expect(val).toMatchObject({ name: 'Resource res-1' });
    });

    it('caches (no second fetch)', async () => {
      await firstDefined(browse.resource(RID));
      await firstDefined(browse.resource(RID));
      expect(http.browseResource).toHaveBeenCalledTimes(1);
    });
  });

  describe('resources()', () => {
    it('fetches on first subscribe', async () => {
      const val = await firstDefined(browse.resources());
      expect(http.browseResources).toHaveBeenCalledTimes(1);
      expect(val).toHaveLength(1);
    });

    it('uses separate cache keys for different filters', async () => {
      await firstDefined(browse.resources({ limit: 10 }));
      await firstDefined(browse.resources({ limit: 20 }));
      expect(http.browseResources).toHaveBeenCalledTimes(2);
    });

    it('forwards search filter to browseResources', async () => {
      await firstDefined(browse.resources({ search: 'foo', limit: 5 }));
      expect(http.browseResources).toHaveBeenCalledWith(5, undefined, 'foo', { auth: undefined });
    });

    it('caches the same search query and re-fetches a different one', async () => {
      await firstDefined(browse.resources({ search: 'foo' }));
      await firstDefined(browse.resources({ search: 'foo' }));
      expect(http.browseResources).toHaveBeenCalledTimes(1);

      await firstDefined(browse.resources({ search: 'bar' }));
      expect(http.browseResources).toHaveBeenCalledTimes(2);
    });
  });

  // ── Entity types ──────────────────────────────────────────────────────

  describe('entityTypes()', () => {
    it('fetches on first subscribe', async () => {
      const val = await firstDefined(browse.entityTypes());
      expect(http.listEntityTypes).toHaveBeenCalledTimes(1);
      expect(val).toEqual(['Person']);
    });
  });

  // ── Invalidation ──────────────────────────────────────────────────────

  describe('invalidateAnnotationList()', () => {
    it('triggers re-fetch', async () => {
      await firstDefined(browse.annotations(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
      browse.invalidateAnnotationList(RID);
      await firstDefined(browse.annotations(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateResourceDetail()', () => {
    it('triggers re-fetch', async () => {
      await firstDefined(browse.resource(RID));
      expect(http.browseResource).toHaveBeenCalledTimes(1);
      browse.invalidateResourceDetail(RID);
      await firstDefined(browse.resource(RID));
      expect(http.browseResource).toHaveBeenCalledTimes(2);
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
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1); // no refetch
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
      // No error, just ignored
      expect(http.browseAnnotations).not.toHaveBeenCalled();
    });
  });

  // ── EventBus reactions (annotation) ───────────────────────────────────

  describe('EventBus → annotation cache', () => {
    it('mark:delete-ok → removes from detail cache', async () => {
      await firstDefined(browse.annotation(RID, AID));
      expect(http.browseAnnotation).toHaveBeenCalledTimes(1);
      eventBus.get('mark:delete-ok').next({ annotationId: AID } as any);
      await firstDefined(browse.annotation(RID, AID));
      expect(http.browseAnnotation).toHaveBeenCalledTimes(2);
    });

    it('mark:added → invalidates list', async () => {
      await firstDefined(browse.annotations(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
      eventBus.get('mark:added').next(stored({ resourceId: RID }) as any);
      await firstDefined(browse.annotations(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });

    it('mark:removed → invalidates list + detail', async () => {
      await firstDefined(browse.annotations(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
      eventBus.get('mark:removed').next(stored({ resourceId: RID, payload: { annotationId: AID } }) as any);
      await firstDefined(browse.annotations(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });

    it('mark:body-updated (enriched) → in-place update, no refetch', async () => {
      await firstDefined(browse.annotations(RID));
      const updated = { ...mockAnnotation('ann-1'), body: [{ type: 'SpecificResource', source: 'res-target', purpose: 'linking' }] } as Annotation;
      eventBus.get('mark:body-updated').next(stored({ resourceId: RID, payload: { annotationId: AID }, annotation: updated }) as any);
      const list = await firstDefined(browse.annotations(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
      expect((list![0].body as any[])[0]).toMatchObject({ source: 'res-target' });
    });

    it('mark:body-updated without annotation → no-op', async () => {
      await firstDefined(browse.annotations(RID));
      eventBus.get('mark:body-updated').next(stored({ resourceId: RID, payload: { annotationId: AID } }) as any);
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
    });

    it('mark:entity-tag-added → invalidates annotation list + resource detail', async () => {
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.resource(RID));
      eventBus.get('mark:entity-tag-added').next(stored({ resourceId: RID }) as any);
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.resource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
      expect(http.browseResource).toHaveBeenCalledTimes(2);
    });

    it('replay-window-exceeded → invalidates annotation list', async () => {
      await firstDefined(browse.annotations(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
      eventBus.get('replay-window-exceeded').next({ resourceId: 'res-1', lastEventId: 1, missedCount: 5000, cap: 1000, message: 'exceeded' });
      await firstDefined(browse.annotations(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });
  });

  // ── EventBus reactions (resource) ─────────────────────────────────────

  describe('EventBus → resource cache', () => {
    it('yield:create-ok → fetches new resource, invalidates lists', async () => {
      await firstDefined(browse.resources());
      eventBus.get('yield:create-ok').next({ resourceId: RID, resource: mockResource('res-1') as any });
      await firstDefined(browse.resource(RID));
      expect(http.browseResource).toHaveBeenCalled();
    });

    it('mark:archived → invalidates resource detail + lists', async () => {
      await firstDefined(browse.resource(RID));
      expect(http.browseResource).toHaveBeenCalledTimes(1);
      eventBus.get('mark:archived').next(stored({ resourceId: RID }) as any);
      await firstDefined(browse.resource(RID));
      expect(http.browseResource).toHaveBeenCalledTimes(2);
    });

    it('mark:unarchived → invalidates resource detail + lists', async () => {
      await firstDefined(browse.resource(RID));
      expect(http.browseResource).toHaveBeenCalledTimes(1);
      eventBus.get('mark:unarchived').next(stored({ resourceId: RID }) as any);
      await firstDefined(browse.resource(RID));
      expect(http.browseResource).toHaveBeenCalledTimes(2);
    });

    it('mark:entity-type-added → invalidates entity types', async () => {
      await firstDefined(browse.entityTypes());
      expect(http.listEntityTypes).toHaveBeenCalledTimes(1);
      eventBus.get('mark:entity-type-added').next(stored({}) as any);
      await firstDefined(browse.entityTypes());
      expect(http.listEntityTypes).toHaveBeenCalledTimes(2);
    });
  });

  // ── Token getter ──────────────────────────────────────────────────────

  describe('token getter', () => {
    it('passes token to annotation list fetches', async () => {
      const tokenBrowse = new BrowseNamespace(http, eventBus, () => 'tok-xyz' as any);
      await firstDefined(tokenBrowse.annotations(RID));
      expect(http.browseAnnotations).toHaveBeenCalledWith(RID, undefined, { auth: 'tok-xyz' });
    });

    it('passes token to resource detail fetches', async () => {
      const tokenBrowse = new BrowseNamespace(http, eventBus, () => 'tok-abc' as any);
      await firstDefined(tokenBrowse.resource(RID));
      expect(http.browseResource).toHaveBeenCalledWith(RID, { auth: 'tok-abc' });
    });
  });
});
