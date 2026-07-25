/**
 * B17 (LOCAL-STORAGE W3) + B18 — rehydration wired through BrowseNamespace.
 *
 * **Declared behavior change (2026-07-24).** This file used to pin
 * "protocol silence": a rehydrated key was served with NO
 * `browse:*-requested` at all. That contract WAS the defect behind
 * .plans/bugs/annotation-lost-on-immediate-reload-after-create.md — an
 * annotation created seconds before a reload is absent from the persisted
 * document, and silence meant nothing ever corrected it (measured: no
 * resumption bookmark exists at failure time, so replay cannot cover it
 * either). Trusting disk content was never sound; the parked
 * rehydrate-then-revalidate option is now the fix.
 *
 * What is pinned NOW: the persisted value is still delivered synchronously
 * (B17's actual win — instant paint, no `undefined` flash), AND exactly one
 * revalidation request follows per rehydrated key (B18). An un-cached key
 * still requests as before. Construction without the persistence option is
 * byte-for-byte today's in-memory behavior.
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
  it('serves a rehydrated resource instantly AND revalidates it (B18); un-cached keys still request', async () => {
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
    // Instant paint from disk — the value arrives without waiting on the
    // wire (the inert transport never answers), which is B17's whole point.
    expect(seen.name).toBe('Cached Doc');
    // B18: and it is revalidated — exactly one request for that key, issued
    // alongside (not instead of) the instant paint.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toBe('browse:resource-requested');

    // An un-cached key still goes to the transport (unchanged).
    browse.resource(makeResourceId('res-uncached')).pipe(take(1)).subscribe();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]![0]).toBe('browse:resource-requested');

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
    // The round trip is proven by the value arriving at all: the transport
    // is inert, so 'Cached Doc' can only have come from storage.
    expect(seen.name).toBe('Cached Doc');
    // B18: rehydrated, therefore revalidated — one request, which the inert
    // transport never answers, leaving the persisted value on screen (B6).
    expect(emit).toHaveBeenCalledTimes(1);
    second.dispose();
  });
});
