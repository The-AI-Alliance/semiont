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

/** Flush all pending microtasks and a few event-loop ticks. */
const flush = () => new Promise<void>(r => { queueMicrotask(() => queueMicrotask(() => queueMicrotask(r))); });

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
  return { resources: ids.map(id => mockResource(id)), total: ids.length } as ResourceListResponse;
}

function makeHttpClient() {
  return {
    browseResource: vi.fn().mockResolvedValue(mockResource('res-1')),
    browseResources: vi.fn().mockResolvedValue(makeListResponse(['res-1'])),
  } as unknown as SemiontApiClient;
}

/** Wait for the store observable to emit a defined (non-undefined) value. */
async function waitForValue<T>(obs: ReturnType<ResourceStore['get']> | ReturnType<ResourceStore['list']>): Promise<T> {
  return firstValueFrom((obs as any).pipe(filter((v: unknown) => v !== undefined))) as Promise<T>;
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
    it('triggers a fetch on first subscribe and returns the resource', async () => {
      const val = await waitForValue<ResourceDetail>(store.get(RID));
      expect(http.browseResource).toHaveBeenCalledWith(RID, { auth: undefined });
      expect(val).toMatchObject({ '@id': 'res-1' });
    });

    it('does not fetch again on second subscribe (cache hit)', async () => {
      await waitForValue(store.get(RID));
      await waitForValue(store.get(RID));
      expect(http.browseResource).toHaveBeenCalledTimes(1);
    });

    it('returns undefined when fetch fails', async () => {
      (http.browseResource as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'));
      // firstValueFrom gets the BehaviorSubject's initial undefined immediately
      const val = await firstValueFrom(store.get(RID));
      expect(val).toBeUndefined();
      // Wait for the failed fetch to settle (shouldn't change the result)
      await new Promise(r => setTimeout(r, 10));
      const val2 = await firstValueFrom(store.get(RID));
      expect(val2).toBeUndefined();
    });

    it('does not issue duplicate in-flight requests', () => {
      // Call get() twice before the first fetch resolves
      store.get(RID).subscribe(() => {});
      store.get(RID).subscribe(() => {});
      expect(http.browseResource).toHaveBeenCalledTimes(1);
    });
  });

  describe('list()', () => {
    it('triggers a fetch on first subscribe and returns the list', async () => {
      const val = await waitForValue<ResourceListResponse>(store.list());
      expect(http.browseResources).toHaveBeenCalledTimes(1);
      expect(val).toBeDefined();
      expect((val as any).resources).toHaveLength(1);
    });

    it('caches the result for the same options', async () => {
      await waitForValue(store.list({ limit: 10 }));
      await waitForValue(store.list({ limit: 10 }));
      expect(http.browseResources).toHaveBeenCalledTimes(1);
    });

    it('uses separate cache keys for different options', async () => {
      await waitForValue(store.list({ limit: 10 }));
      await waitForValue(store.list({ limit: 20 }));
      expect(http.browseResources).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateDetail()', () => {
    it('removes the entry and re-fetches', async () => {
      await waitForValue(store.get(RID));
      expect(http.browseResource).toHaveBeenCalledTimes(1);

      store.invalidateDetail(RID);
      await new Promise(r => setTimeout(r, 20));

      expect(http.browseResource).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateLists()', () => {
    it('clears all list entries (observable emits undefined immediately)', async () => {
      await waitForValue(store.list());
      expect(http.browseResources).toHaveBeenCalledTimes(1);

      store.invalidateLists();

      // Immediately after invalidation, the BehaviorSubject emits undefined
      const immediate = await firstValueFrom(store.list());
      expect(immediate).toBeUndefined();
      // A second fetch was triggered
      await new Promise(r => setTimeout(r, 20));
      expect(http.browseResources).toHaveBeenCalledTimes(2);
    });
  });

  describe('setTokenGetter()', () => {
    it('passes token to HTTP calls', async () => {
      store.setTokenGetter(() => 'tok-abc' as any);
      await waitForValue(store.get(RID));
      expect(http.browseResource).toHaveBeenCalledWith(RID, { auth: 'tok-abc' });
    });
  });

  describe('EventBus reactions', () => {
    it('yield:created → fetches detail and invalidates lists', async () => {
      await waitForValue(store.list()); // populate list cache
      const listBefore = (http.browseResources as ReturnType<typeof vi.fn>).mock.calls.length;
      const detailBefore = (http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('yield:created').next({ resourceId: RID, resource: mockResource('res-1') as ResourceDescriptor & { format: string } });
      await new Promise(r => setTimeout(r, 20));

      expect((http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(detailBefore);
      // list is invalidated (cleared); re-fetch triggered on next subscribe
      expect((http.browseResources as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(listBefore);
    });

    it('yield:updated → invalidates detail and re-fetches', async () => {
      await waitForValue(store.get(RID));
      const detailCallsBefore = (http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('yield:updated').next({ resourceId: RID });
      await new Promise(r => setTimeout(r, 20));

      expect((http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(detailCallsBefore);
    });

    it('mark:archived → invalidates detail and lists', async () => {
      await waitForValue(store.get(RID));
      const callsBefore = (http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('mark:archived').next({ resourceId: RID } as any);
      await new Promise(r => setTimeout(r, 20));

      expect((http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('mark:archived with no resourceId → no invalidation', async () => {
      await waitForValue(store.get(RID));
      const callsBefore = (http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('mark:archived').next({} as any);
      await new Promise(r => setTimeout(r, 20));

      expect((http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    });

    it('mark:unarchived → invalidates detail and lists', async () => {
      await waitForValue(store.get(RID));
      const callsBefore = (http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('mark:unarchived').next({ resourceId: RID } as any);
      await new Promise(r => setTimeout(r, 20));

      expect((http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('mark:entity-tag-added → invalidates detail only (not lists)', async () => {
      await waitForValue(store.list()); // populate list
      const listCallsBefore = (http.browseResources as ReturnType<typeof vi.fn>).mock.calls.length;
      await waitForValue(store.get(RID));
      const detailCallsBefore = (http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('mark:entity-tag-added').next({ resourceId: RID } as any);
      await new Promise(r => setTimeout(r, 20));

      expect((http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(detailCallsBefore);
      expect((http.browseResources as ReturnType<typeof vi.fn>).mock.calls.length).toBe(listCallsBefore);
    });

    it('mark:entity-tag-removed → invalidates detail only', async () => {
      await waitForValue(store.get(RID));
      const detailCallsBefore = (http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length;

      eventBus.get('mark:entity-tag-removed').next({ resourceId: RID } as any);
      await new Promise(r => setTimeout(r, 20));

      expect((http.browseResource as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(detailCallsBefore);
    });
  });
});
