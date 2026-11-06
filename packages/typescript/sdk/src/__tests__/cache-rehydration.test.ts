/**
 * B17 + B18 — rehydration wired through BrowseNamespace.
 *
 * What is kept is one person's, on one knowledge base: a namespace given
 * persistence at construction loads what is kept for them then; one made
 * keeping nothing keeps nothing until it is given persistence, which loads
 * what is kept into the keys it does not already hold.
 *
 * A rehydrated key is NOT served in protocol silence. An annotation created
 * seconds before a reload is absent from the persisted document, and with
 * no `browse:*-requested` nothing would ever correct it (the resumption
 * bookmark may not be persisted either, so replay cannot cover it). Disk
 * content is stale until revalidated.
 *
 * What is pinned: the persisted value is delivered synchronously (B17's
 * actual win — instant paint, no `pending` flash), AND exactly one
 * revalidation CHAIN follows per rehydrated key (B18) — one request, plus
 * B14's single bounded retry if it fails. An un-cached key requests.
 * Construction without the persistence option is in-memory only.
 */
import { describe, it, expect, vi } from 'vitest';
import { map, firstValueFrom, filter, take } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { IContentTransport, ITransport, ResourceDescriptor } from '@semiont/core';
import { isReady } from '../cache';
import { BrowseNamespace } from '../namespaces/browse';
import { sessionStoragePersister } from '../cache-persister';
import { cacheKey } from '../session/storage';
import { TestStorage } from '../session/__tests__/test-storage-helpers';
import { inMemoryTransport, type InMemoryTransportOptions } from './helpers/in-memory-transport';
import { mockResource } from './fixtures/resource';

function inertTransport(onEmit: InMemoryTransportOptions['onEmit']): ITransport {
  return inMemoryTransport({ onEmit });
}

const RID = makeResourceId('res-cached');
const DESCRIPTOR = mockResource(RID, { name: 'Cached Doc' });

/** The person and the knowledge base what is kept is kept for. */
const KEPT_FOR = { kbId: 'kb-1', personKey: 'gqB898gk4Ww_orAHhzDCSVl7yHP9UEsX0DA_xbGbq-I' };
const RESOURCE_KEY = cacheKey(KEPT_FOR.kbId, KEPT_FOR.personKey, 'resource');

/** Write `value` under `id` as a fetch result reaching the store would (B13b's write-through). */
function write(browse: BrowseNamespace, id: string, value: ResourceDescriptor): void {
  (browse as unknown as { resourceCache: { set(k: string, v: ResourceDescriptor): void } }).resourceCache.set(id, value);
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('BrowseNamespace cache rehydration (B17)', () => {
  it('serves a rehydrated resource instantly AND revalidates it (B18); un-cached keys still request', async () => {
    const storage = new TestStorage();
    sessionStoragePersister<string, ResourceDescriptor>({
      storage,
      storageKey: RESOURCE_KEY,
      version: 1,
    }).save(new Map([[String(RID), DESCRIPTOR]]));

    const emit = vi.fn<(channel: string, ...rest: unknown[]) => Promise<number>>(async () => 1);
    const browse = new BrowseNamespace(
      inertTransport(emit),
      new EventBus(),
      {} as unknown as IContentTransport,
      { busTimeoutMs: 50, cachePersistence: { storage, ...KEPT_FOR } },
    );

    const seen = await firstValueFrom(
      browse.resource(RID).pipe(filter(isReady), map((s) => s.value), take(1)),
    );
    // Instant paint from disk — the value arrives without waiting on the
    // wire (the inert transport never answers), which is B17's whole point.
    expect(seen.name).toBe('Cached Doc');
    // B18: and it is revalidated — one chain for that key (this first
    // request, plus a B14 retry only if it fails), issued alongside (not
    // instead of) the instant paint.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toBe('browse:resource-requested');

    // An un-cached key goes to the transport.
    browse.resource(makeResourceId('res-uncached')).pipe(take(1)).subscribe();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]![0]).toBe('browse:resource-requested');

    browse.dispose();
  });

  it('persists what it fetches: a later construction rehydrates it', async () => {
    const storage = new TestStorage();
    const first = new BrowseNamespace(
      inertTransport(async () => 1),
      new EventBus(),
      {} as unknown as IContentTransport,
      { busTimeoutMs: 50, cachePersistence: { storage, ...KEPT_FOR } },
    );
    // Write-through (B13b) stands in for a fetch result reaching the store.
    first.resource(RID); // materialize the per-key observable
    write(first, String(RID), DESCRIPTOR);
    await new Promise((resolve) => setTimeout(resolve, 80)); // > save debounce
    first.dispose();

    const emit = vi.fn(async () => 1);
    const second = new BrowseNamespace(
      inertTransport(emit),
      new EventBus(),
      {} as unknown as IContentTransport,
      { busTimeoutMs: 50, cachePersistence: { storage, ...KEPT_FOR } },
    );
    const seen = await firstValueFrom(
      second.resource(RID).pipe(filter(isReady), map((s) => s.value), take(1)),
    );
    // The round trip is proven by the value arriving at all: the transport
    // is inert, so 'Cached Doc' can only have come from storage.
    expect(seen.name).toBe('Cached Doc');
    // B18: rehydrated, therefore revalidated — one chain, whose first
    // request the inert transport never answers, leaving the persisted value
    // on screen (B6).
    expect(emit).toHaveBeenCalledTimes(1);
    second.dispose();
  });

  it('keeps nothing until given persistence; then fills only the keys it does not hold, revalidates them (B18), and saves', async () => {
    const HELD = makeResourceId('res-held');
    const storage = new TestStorage();
    sessionStoragePersister<string, ResourceDescriptor>({ storage, storageKey: RESOURCE_KEY, version: 1 }).save(
      new Map([
        [String(RID), DESCRIPTOR],
        [String(HELD), mockResource(HELD, { name: 'Kept, but held anew' })],
      ]),
    );
    const kept = storage.get(RESOURCE_KEY);

    const emit = vi.fn<(channel: string, ...rest: unknown[]) => Promise<number>>(async () => 1);
    const browse = new BrowseNamespace(
      inertTransport(emit),
      new EventBus(),
      {} as unknown as IContentTransport,
      { busTimeoutMs: 50 },
    );
    browse.resource(HELD);
    write(browse, String(HELD), mockResource(HELD, { name: 'Held' }));
    await settle(80); // > save debounce
    // Made keeping nothing: nothing it holds is written.
    expect(storage.get(RESOURCE_KEY)).toBe(kept);

    browse.attachPersistence({ storage, ...KEPT_FOR });

    const restored = await firstValueFrom(browse.resource(RID).pipe(filter(isReady), map((s) => s.value), take(1)));
    expect(restored.name).toBe('Cached Doc');
    // B17-Q: a cache given persistence late is one the bookmark waits for, and its revalidation is in flight.
    expect(browse.persistenceSettled()).toBe(false);
    // What it held stands: a kept value fills only a key it does not hold.
    const held = await firstValueFrom(browse.resource(HELD).pipe(filter(isReady), map((s) => s.value), take(1)));
    expect(held.name).toBe('Held');
    // B18: the restored key is revalidated, once; the held one is not asked for.
    expect(emit.mock.calls.map(([channel, payload]) => [channel, payload])).toEqual([
      ['browse:resource-requested', { resourceId: RID }],
    ]);

    // And from now on what it holds is saved under the person's key.
    write(browse, String(HELD), mockResource(HELD, { name: 'Held again' }));
    await settle(80);
    const saved = JSON.parse(storage.get(RESOURCE_KEY) ?? 'null') as { entries: Array<[string, ResourceDescriptor, number]> };
    expect(Object.fromEntries(saved.entries.map(([id, value]) => [id, value.name]))).toEqual({
      [String(RID)]: 'Cached Doc',
      [String(HELD)]: 'Held again',
    });
    browse.dispose();
  });
});
