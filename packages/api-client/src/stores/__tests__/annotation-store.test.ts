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

      eventBus.get('mark:deleted').next({ annotationId: AID } as any);

      // mark:deleted removes from cache without re-fetching; next get() re-fetches
      await firstDefined(store.get(RID, AID));
      expect(http.browseAnnotation).toHaveBeenCalledTimes(2);
    });

    it('mark:added → invalidates list; next subscribe re-fetches', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      eventBus.get('mark:added').next({ resourceId: RID } as any);

      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });

    it('mark:added with no resourceId → no list invalidation', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      eventBus.get('mark:added').next({} as any);

      // Cache still populated; second subscribe returns cached value, no re-fetch
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
    });

    it('mark:removed → invalidates list; next subscribe re-fetches', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      eventBus.get('mark:removed').next({ resourceId: RID, payload: { annotationId: AID } } as any);

      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });

    it('mark:body-updated → invalidates list; next subscribe re-fetches', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      eventBus.get('mark:body-updated').next({ resourceId: RID, payload: { annotationId: AID } } as any);

      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });

    it('mark:entity-tag-added → invalidates list', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      eventBus.get('mark:entity-tag-added').next({ resourceId: RID } as any);

      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });

    it('mark:entity-tag-removed → invalidates list', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      eventBus.get('mark:entity-tag-removed').next({ resourceId: RID } as any);

      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(2);
    });

    it('mark:entity-tag-added with no resourceId → no invalidation', async () => {
      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);

      eventBus.get('mark:entity-tag-added').next({} as any);

      await firstDefined(store.listForResource(RID));
      expect(http.browseAnnotations).toHaveBeenCalledTimes(1);
    });
  });
});
