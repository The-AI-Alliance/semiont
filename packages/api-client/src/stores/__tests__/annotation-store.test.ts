/**
 * AnnotationStore tests
 *
 * Tests lazy fetch, cache invalidation, and EventBus-driven updates.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { firstValueFrom, filter } from 'rxjs';
import { EventBus, resourceId, annotationId } from '@semiont/core';
import type { components } from '@semiont/core';
import { AnnotationStore } from '../annotation-store';
import type { SemiontApiClient } from '../../client';
import type { AnnotationsListResponse, AnnotationDetail } from '../annotation-store';

type Annotation = components['schemas']['Annotation'];

/** Create flat StoredEvent shape for domain event channels */
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

function makeListResponse(ids: string[]): AnnotationsListResponse {
  return { annotations: ids.map(id => mockAnnotation(id)), total: ids.length } as unknown as AnnotationsListResponse;
}

function makeDetailResponse(id: string): AnnotationDetail {
  return { annotation: mockAnnotation(id) } as unknown as AnnotationDetail;
}

function makeHttpClient() {
  return {
    browseAnnotations: vi.fn().mockResolvedValue(makeListResponse(['ann-1'])),
    browseAnnotation: vi.fn().mockResolvedValue(makeDetailResponse('ann-1')),
  } as unknown as SemiontApiClient;
}

/** Wait for the first defined value from a store observable. */
function firstDefined<T>(obs: ReturnType<AnnotationStore['listForResource']> | ReturnType<AnnotationStore['get']>): Promise<T> {
  return firstValueFrom((obs as any).pipe(filter((v: unknown): v is T => v !== undefined)));
}

describe('AnnotationStore', () => {
  let eventBus: EventBus;
  let http: SemiontApiClient;
  let store: AnnotationStore;
  const RID = resourceId('res-1');
  const AID = annotationId('ann-1');

  beforeEach(() => {
    eventBus = new EventBus();
    http = makeHttpClient();
    store = new AnnotationStore(http, eventBus);
  });

  describe('listForResource()', () => {
    it('fetches on first subscribe and returns the list', async () => {
      const val = await firstDefined<AnnotationsListResponse>(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledWith(RID, undefined, { auth: undefined });
      expect((val as any).annotations).toHaveLength(1);
    });

    it('caches the result (no second fetch)', async () => {
      await firstDefined(store.listForResource(RID));
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
    });

    it('does not issue duplicate in-flight requests', () => {
      store.listForResource(RID).subscribe(() => {});
      store.listForResource(RID).subscribe(() => {});
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
    });
  });

  describe('get()', () => {
    it('fetches on first subscribe and returns the annotation', async () => {
      const val = await firstDefined<AnnotationDetail>(store.get(RID, AID));
      expect(http.browseAnnotation).toHaveBeenCalledWith(RID, AID, { auth: undefined });
      expect(val).toBeDefined();
    });

    it('caches the result', async () => {
      await firstDefined(store.get(RID, AID));
      await firstDefined(store.get(RID, AID));
      expect(http.browseAnnotation).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalidateList()', () => {
    it('removes the entry and triggers a re-fetch', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      store.invalidateList(RID);

      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateDetail()', () => {
    it('removes the detail from cache (no automatic re-fetch)', async () => {
      await firstDefined(store.get(RID, AID));
      expect(http.browseAnnotation).toHaveBeenCalledTimes(1);

      store.invalidateDetail(AID);

      // A second subscribe triggers a new fetch (lazy re-population)
      await firstDefined(store.get(RID, AID));
      expect(http.browseAnnotation).toHaveBeenCalledTimes(2);
    });
  });

  describe('setTokenGetter()', () => {
    it('passes the token to list fetches', async () => {
      store.setTokenGetter(() => 'tok-xyz' as any);
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledWith(RID, undefined, { auth: 'tok-xyz' });
    });

    it('passes the token to detail fetches', async () => {
      store.setTokenGetter(() => 'tok-xyz' as any);
      await firstDefined(store.get(RID, AID));
      expect(http.browseAnnotation).toHaveBeenCalledWith(RID, AID, { auth: 'tok-xyz' });
    });
  });

  describe('EventBus reactions', () => {
    it('mark:deleted → removes from detail cache; next subscribe re-fetches', async () => {
      await firstDefined(store.get(RID, AID));
      expect(http.browseAnnotation).toHaveBeenCalledTimes(1);

      eventBus.get('mark:delete-ok').next({ annotationId: AID } as any);

      // mark:deleted removes from cache without re-fetching; next get() re-fetches
      await firstDefined(store.get(RID, AID));
      expect(http.browseAnnotation).toHaveBeenCalledTimes(2);
    });

    it('mark:added → invalidates list; next subscribe re-fetches', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      eventBus.get('mark:added').next(stored({ resourceId: RID }) as any);

      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });

    it('mark:added with no resourceId → no list invalidation', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      eventBus.get('mark:added').next(stored({}) as any);

      // Cache still populated; second subscribe returns cached value, no re-fetch
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
    });

    it('mark:removed → invalidates list; next subscribe re-fetches', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      eventBus.get('mark:removed').next(stored({ resourceId: RID, payload: { annotationId: AID } }) as any);

      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });

    it('mark:body-updated → updateInPlace from enriched annotation, no refetch', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      // Enriched event from events-stream carries the post-materialization
      // annotation. The subscriber writes it directly into the cached list.
      const updatedAnnotation: Annotation = {
        ...mockAnnotation('ann-1'),
        motivation: 'linking',
        body: [{ type: 'SpecificResource', source: 'res-target', purpose: 'linking' }],
      } as Annotation;

      eventBus.get('mark:body-updated').next(stored({
        resourceId: RID,
        payload: { annotationId: AID },
        annotation: updatedAnnotation,
      }) as any);

      // No refetch — the next subscribe sees the updated state from cache
      const list = await firstDefined<AnnotationsListResponse>(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
      expect((list as any).annotations[0].body[0]).toMatchObject({
        type: 'SpecificResource',
        source: 'res-target',
      });
    });

    it('mark:body-updated without annotation enrichment → no-op (defensive)', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      // An un-enriched event would indicate a backend bug (the events-stream
      // enrichment step should always populate the annotation field for this
      // event type). The subscriber drops it rather than refetching.
      eventBus.get('mark:body-updated').next(stored({
        resourceId: RID,
        payload: { annotationId: AID },
      }) as any);

      // No refetch, no in-place update
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
    });

    it('mark:entity-tag-added → invalidates list', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      eventBus.get('mark:entity-tag-added').next(stored({ resourceId: RID }) as any);

      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });

    it('mark:entity-tag-removed → invalidates list', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      eventBus.get('mark:entity-tag-removed').next(stored({ resourceId: RID }) as any);

      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });

    it('mark:entity-tag-added with no resourceId → no invalidation', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      eventBus.get('mark:entity-tag-added').next(stored({}) as any);

      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateInPlace()', () => {
    /**
     * Build an annotation with a SpecificResource body item — the kind of
     * post-bind state that flows back from bind:finished.
     */
    function withResolvedBody(id: string, source: string): Annotation {
      return {
        ...mockAnnotation(id),
        motivation: 'linking',
        body: [{ type: 'SpecificResource', source, purpose: 'linking' }],
      } as Annotation;
    }

    it('replaces an existing annotation in a cached list', async () => {
      // Seed cache by subscribing
      await firstDefined<AnnotationsListResponse>(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      const updated = withResolvedBody('ann-1', 'res-2');
      store.updateInPlace(RID, updated);

      // The next subscribe should see the updated annotation, no fetch
      const list = await firstDefined<AnnotationsListResponse>(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
      expect((list as any).annotations).toHaveLength(1);
      expect((list as any).annotations[0].body[0]).toMatchObject({
        type: 'SpecificResource',
        source: 'res-2',
      });
    });

    it('appends a new annotation if not present in the cached list', async () => {
      await firstDefined<AnnotationsListResponse>(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      const newAnn = withResolvedBody('ann-2', 'res-3');
      store.updateInPlace(RID, newAnn);

      const list = await firstDefined<AnnotationsListResponse>(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
      expect((list as any).annotations).toHaveLength(2);
      expect((list as any).annotations.map((a: Annotation) => a.id)).toContain('ann-2');
    });

    it('is a no-op when list is not cached', async () => {
      // Do NOT subscribe first; cache is cold
      const newAnn = withResolvedBody('ann-1', 'res-2');
      store.updateInPlace(RID, newAnn);

      // First subscribe should trigger a normal cold-cache fetch
      const list = await firstDefined<AnnotationsListResponse>(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
      // It returns the mocked HTTP response (which has ann-1 with empty body),
      // NOT the synthetic in-place update
      expect((list as any).annotations[0].body).toEqual([]);
    });

    it('emits each in-place update on the observable', async () => {
      const seen: AnnotationsListResponse[] = [];
      const sub = store.listForResource(RID).subscribe((v) => {
        if (v) seen.push(v);
      });

      // Wait for the initial fetch
      await firstDefined<AnnotationsListResponse>(store.listForResource(RID));

      const first = withResolvedBody('ann-1', 'res-A');
      store.updateInPlace(RID, first);

      const second = withResolvedBody('ann-1', 'res-B');
      store.updateInPlace(RID, second);

      sub.unsubscribe();

      // We should have at least 3 emissions: initial fetch, first update, second update
      expect(seen.length).toBeGreaterThanOrEqual(3);
      const last = seen[seen.length - 1] as any;
      expect(last.annotations[0].body[0]).toMatchObject({ source: 'res-B' });
    });

    it('replay-window-exceeded → invalidateList for that resource', async () => {
      // Prime the cache
      await firstDefined<AnnotationsListResponse>(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      // Simulate the events-stream reporting that too many events were missed
      eventBus.get('replay-window-exceeded').next({
        resourceId: 'res-1',
        lastEventId: 1,
        missedCount: 5000,
        cap: 1000,
        message: 'Replay window exceeded',
      });

      // The cache for this resource was invalidated; next subscribe refetches
      await firstDefined<AnnotationsListResponse>(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });

    it('events-stream enriched event is the canonical update path (single source of truth)', async () => {
      // Seed cache
      await firstDefined<AnnotationsListResponse>(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      const updated = withResolvedBody('ann-1', 'res-2');

      // Simulate the events-stream delivering an EnrichedResourceEvent for
      // mark:body-updated. After the unification, this is the single path
      // for both local and remote mutations — the subscriber writes the
      // annotation directly into the cached list.
      eventBus.get('mark:body-updated').next(stored({
        resourceId: RID,
        payload: { annotationId: AID },
        annotation: updated,
      }) as any);

      // The cache reflects the updated state, no refetch
      const list = await firstDefined<AnnotationsListResponse>(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
      expect((list as any).annotations).toHaveLength(1);
      expect((list as any).annotations[0].body[0]).toMatchObject({
        type: 'SpecificResource',
        source: 'res-2',
      });
    });
  });
});
