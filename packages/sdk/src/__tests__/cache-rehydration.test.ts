/**
 * B17 (LOCAL-STORAGE W3) — rehydration wired through BrowseNamespace.
 *
 * The protocol-silence pin: with a prepopulated storage adapter, observing a
 * rehydrated key delivers the persisted value synchronously and emits NO
 * `browse:*-requested` on the transport. An un-cached key still requests as
 * today. Construction without the option is byte-for-byte today's behavior.
 * (Known limitation under fix: see
 * .plans/bugs/pdf-annotations-vanish-after-reload-stale-persisted-cache.md —
 * the (a)+(b) causal-gating work is what makes trusting rehydrated content
 * sound; rehydrate-then-revalidate was considered and parked there.)
 */
import { describe, it, expect, vi } from 'vitest';
import { Subject, firstValueFrom, filter, take } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { IContentTransport, ITransport, ResourceDescriptor } from '@semiont/core';
import { BrowseNamespace } from '../namespaces/browse';
import { sessionStoragePersister } from '../cache-persister';
import { TestStorage } from '../session/__tests__/test-storage-helpers';

function inertTransport(emit: ITransport['emit']): ITransport {
  return {
    baseUrl: 'http://test',
    emit,
    stream: () => new Subject().asObservable(),
    subscribeToResource: () => () => {},
    bridgeInto: () => {},
    state$: new Subject(),
    errors$: new Subject(),
    dispose: () => {},
  } as unknown as ITransport;
}

const RID = makeResourceId('res-cached');
const DESCRIPTOR = { '@id': RID, name: 'Cached Doc' } as unknown as ResourceDescriptor;

describe('BrowseNamespace cache rehydration (B17)', () => {
  it('serves a rehydrated resource with NO transport request; un-cached keys still request', async () => {
    const storage = new TestStorage();
    sessionStoragePersister<string, ResourceDescriptor>({
      storage,
      storageKey: 'semiont.cache.kb-1.resource',
      version: 1,
    }).save(new Map([[String(RID), DESCRIPTOR]]));

    const emit = vi.fn<(channel: string, ...rest: unknown[]) => Promise<void>>(async () => {});
    const browse = new BrowseNamespace(
      inertTransport(emit as unknown as ITransport['emit']),
      new EventBus(),
      {} as unknown as IContentTransport,
      { busTimeoutMs: 50, cachePersistence: { storage, keyPrefix: 'kb-1' } },
    );

    const seen = await firstValueFrom(
      browse.resource(RID).pipe(filter((r): r is ResourceDescriptor => r !== undefined), take(1)),
    );
    expect(seen.name).toBe('Cached Doc');
    expect(emit).not.toHaveBeenCalled();

    // An un-cached key still goes to the transport.
    browse.resource(makeResourceId('res-uncached')).pipe(take(1)).subscribe();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toBe('browse:resource-requested');

    browse.dispose();
  });

  it('persists what it fetches: a later construction rehydrates it', async () => {
    const storage = new TestStorage();
    const first = new BrowseNamespace(
      inertTransport(async () => {}),
      new EventBus(),
      {} as unknown as IContentTransport,
      { busTimeoutMs: 50, cachePersistence: { storage, keyPrefix: 'kb-1' } },
    );
    // Write-through (B13b) stands in for a fetch result reaching the store.
    first.resource(RID); // materialize the per-key observable
    (first as unknown as { resourceCache: { set(k: string, v: ResourceDescriptor): void } })
      .resourceCache.set(String(RID), DESCRIPTOR);
    await new Promise((resolve) => setTimeout(resolve, 80)); // > save debounce
    first.dispose();

    const emit = vi.fn(async () => {});
    const second = new BrowseNamespace(
      inertTransport(emit),
      new EventBus(),
      {} as unknown as IContentTransport,
      { busTimeoutMs: 50, cachePersistence: { storage, keyPrefix: 'kb-1' } },
    );
    const seen = await firstValueFrom(
      second.resource(RID).pipe(filter((r): r is ResourceDescriptor => r !== undefined), take(1)),
    );
    expect(seen.name).toBe('Cached Doc');
    expect(emit).not.toHaveBeenCalled();
    second.dispose();
  });
});
