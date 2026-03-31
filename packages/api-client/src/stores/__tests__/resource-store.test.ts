/**
 * ResourceStore tests
 *
 * Tests lazy fetch, cache invalidation, and EventBus-driven updates.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { firstValueFrom, filter } from 'rxjs';
import { EventBus, resourceId } from '@semiont/core';
import type { components } from '@semiont/core';
import { ResourceStore } from '../resource-store';
import type { SemiontApiClient } from '../../client';
import type { ResourceDetail, ResourceListResponse } from '../resource-store';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

function mockResource(id: string): ResourceDescriptor {
  return {
    '@context': 'http://schema.org',
    '@id': id,
    name: `Resource ${id}`,
    representations: [],
  };
}

function makeListResponse(ids: string[]): ResourceListResponse {
  return { resources: ids.map(id => mockResource(id)), total: ids.length } as unknown as ResourceListResponse;
}

function makeHttpClient() {
  return {
    browseResource: vi.fn().mockResolvedValue(mockResource('res-1')),
    browseResources: vi.fn().mockResolvedValue(makeListResponse(['res-1'])),
  } as unknown as SemiontApiClient;
}

/** Subscribe to the store and wait for the first defined value. */
function firstDefined<T>(obs: ReturnType<ResourceStore['get']> | ReturnType<ResourceStore['list']>): Promise<T> {
  return firstValueFrom((obs as any).pipe(filter((v: unknown): v is T => v !== undefined)));
}

describe('ResourceStore', () => {
  let eventBus: EventBus;
  let http: SemiontApiClient;
  let store: ResourceStore;
  const RID = resourceId('res-1');

  beforeEach(() => {
    eventBus = new EventBus();
    http = makeHttpClient();
    store = new ResourceStore(http, eventBus);
  });

  describe('get()', () => {
    it('fetches on first subscribe and returns the resource', async () => {
      const val = await firstDefined<ResourceDetail>(store.get(RID));
      expect(http.browseResource).toHaveBeenCalledWith(RID, { auth: undefined });
      expect(val).toMatchObject({ '@id': 'res-1' });
    });

    it('does not fetch again on second subscribe (cache hit)', async () => {
      await firstDefined(store.get(RID));
      await firstDefined(store.get(RID));
      expect(http.browseResource).toHaveBeenCalledTimes(1);
    });

    it('does not issue duplicate in-flight requests for the same id', () => {
      store.get(RID).subscribe(() => {});
      store.get(RID).subscribe(() => {});
      expect(http.browseResource).toHaveBeenCalledTimes(1);
    });
  });

  describe('list()', () => {
    it('fetches on first subscribe and returns the list', async () => {
      const val = await firstDefined<ResourceListResponse>(store.list());
      expect(http.browseResources).toHaveBeenCalledTimes(1);
      expect((val as any).resources).toHaveLength(1);
    });

    it('caches the result for the same options', async () => {
      await firstDefined(store.list({ limit: 10 }));
      await firstDefined(store.list({ limit: 10 }));
      expect(http.browseResources).toHaveBeenCalledTimes(1);
    });

    it('uses separate cache keys for different options', async () => {
      await firstDefined(store.list({ limit: 10 }));
      await firstDefined(store.list({ limit: 20 }));
      expect(http.browseResources).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateDetail()', () => {
    it('removes the entry and triggers a re-fetch', async () => {
      await firstDefined(store.get(RID));
      expect(http.browseResource).toHaveBeenCalledTimes(1);

      store.invalidateDetail(RID);

      await firstDefined(store.get(RID));
      expect(http.browseResource).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateLists()', () => {
    it('clears list entries so the next subscribe re-fetches', async () => {
      await firstDefined(store.list());
      expect(http.browseResources).toHaveBeenCalledTimes(1);

      store.invalidateLists();

      await firstDefined(store.list());
      expect(http.browseResources).toHaveBeenCalledTimes(2);
    });
  });

  describe('setTokenGetter()', () => {
    it('passes the token to HTTP calls', async () => {
      store.setTokenGetter(() => 'tok-abc' as any);
      await firstDefined(store.get(RID));
      expect(http.browseResource).toHaveBeenCalledWith(RID, { auth: 'tok-abc' });
    });
  });

  describe('EventBus reactions', () => {
    it('yield:created → fetches the new resource detail and invalidates lists', async () => {
      await firstDefined(store.list()); // populate list cache
      const listCallsBefore = (http.browseResources as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('yield:created').next({ resourceId: RID, resource: mockResource('res-1') as any });

      // The detail fetch triggered by yield:created should complete
      await firstDefined(store.get(RID));
      expect(http.browseResource).toHaveBeenCalled();
      // List was invalidated; re-fetch on next subscribe
      await firstDefined(store.list());
      expect((http.browseResources as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(listCallsBefore);
    });

    it('yield:updated → invalidates detail and re-fetches', async () => {
      await firstDefined(store.get(RID));
      const callsBefore = (http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('yield:updated').next({ resourceId: RID });

      await firstDefined(store.get(RID));
      expect((http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('mark:archived → invalidates detail and re-fetches', async () => {
      await firstDefined(store.get(RID));
      const callsBefore = (http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('mark:archived').next({ resourceId: RID } as any);

      await firstDefined(store.get(RID));
      expect((http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('mark:archived with no resourceId → no invalidation', async () => {
      await firstDefined(store.get(RID));
      const callsBefore = (http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('mark:archived').next({} as any);

      // No invalidation: second subscribe still returns cached value without re-fetching
      await firstDefined(store.get(RID));
      expect((http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    });

    it('mark:unarchived → invalidates detail and re-fetches', async () => {
      await firstDefined(store.get(RID));
      const callsBefore = (http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('mark:unarchived').next({ resourceId: RID } as any);

      await firstDefined(store.get(RID));
      expect((http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('mark:entity-tag-added → invalidates detail only, not lists', async () => {
      await firstDefined(store.list());
      const listCallsBefore = (http.browseResources as ReturnType<typeof vi.fn>).mock.calls.length;
      await firstDefined(store.get(RID));
      const detailCallsBefore = (http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('mark:entity-tag-added').next({ resourceId: RID } as any);

      await firstDefined(store.get(RID));
      expect((http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(detailCallsBefore);
      // List was NOT invalidated
      expect((http.browseResources as ReturnType<typeof vi.fn>).mock.calls.length).toBe(listCallsBefore);
    });

    it('mark:entity-tag-removed → invalidates detail only', async () => {
      await firstDefined(store.get(RID));
      const callsBefore = (http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('mark:entity-tag-removed').next({ resourceId: RID } as any);

      await firstDefined(store.get(RID));
      expect((http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});
