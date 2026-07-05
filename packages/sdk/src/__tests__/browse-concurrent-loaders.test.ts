/**
 * Integration repro for `.plans/bugs/concurrent-browse-resource-starvation.md`:
 * mount N loaders for N DISTINCT resources at connect time (the embeddable
 * viewer's "resource per chat message" pattern — `useResourceLoader` per
 * message) and require that ALL N resolve. Pre-fix, exactly one resolved and
 * the other N−1 starved forever:
 *
 *   - loaders 2..N: `subscribeToResource` threw (single-scope contention) and
 *     errored their subscriptions silently → fixed by withScope degrading to
 *     unscoped observation (browse.ts);
 *   - replies lost on the wire (SSE swap abort) left the per-key cache
 *     pending forever → fixed by the transport linger-drain
 *     (http-transport actor-state-unit, tested there) and the cache's bounded
 *     SWR retry (B14, cache.ts) as defense in depth.
 *
 * This file automates the repro at the `BrowseNamespace` level, mimicking
 * `useResourceLoader`'s consumption: one `resource(rid)` + one
 * `annotations(rid)` live-query subscription per loader.
 */

import { describe, it, expect, vi } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { IContentTransport, ITransport, ResourceId } from '@semiont/core';
import { BrowseNamespace } from '../namespaces/browse';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Fake transport with HttpTransport's SINGLE-scope `subscribeToResource`
 * contract (throws for a second distinct resource while one is held) and
 * synchronous correlated replies. `failFirstResourceFetchFor` makes the
 * first `browse:resource-requested` emit for that rid reject — simulating a
 * request whose reply was lost (busRequest timeout), which drives the B14
 * retry path.
 */
function makeSingleScopeTransport(opts: { failFirstResourceFetchFor?: string } = {}) {
  const subjects = new Map<string, Subject<Record<string, unknown>>>();
  const subjectFor = (channel: string) => {
    let s = subjects.get(channel);
    if (!s) {
      s = new Subject<Record<string, unknown>>();
      subjects.set(channel, s);
    }
    return s;
  };

  let active: { rId: ResourceId; refCount: number } | null = null;
  const subscribeToResource = vi.fn((rId: ResourceId) => {
    if (active && active.rId !== rId) {
      throw new Error(`HttpTransport already subscribed to resource ${active.rId}`);
    }
    if (active) active.refCount++;
    else active = { rId, refCount: 1 };
    return () => {
      if (active && --active.refCount <= 0) active = null;
    };
  });

  let pendingFailure = opts.failFirstResourceFetchFor;

  const transport = {
    baseUrl: 'http://test',
    emit: async (channel: string, payload: Record<string, unknown>) => {
      if (channel === 'browse:resource-requested') {
        const rid = payload.resourceId as string;
        if (pendingFailure === rid) {
          // One-shot loss: the request never gets a reply (the real failure
          // is a busRequest timeout; a rejected emit produces the same
          // fetch rejection without waiting 30s).
          pendingFailure = undefined;
          throw new Error(`simulated lost reply for ${rid}`);
        }
        subjectFor('browse:resource-result').next({
          correlationId: payload.correlationId as string,
          response: { resource: { '@id': rid, name: `Resource ${rid}` } },
        });
      }
      if (channel === 'browse:annotations-requested') {
        subjectFor('browse:annotations-result').next({
          correlationId: payload.correlationId as string,
          response: { annotations: [], total: 0 },
        });
      }
    },
    stream: (channel: string): Observable<Record<string, unknown>> => subjectFor(channel).asObservable(),
    subscribeToResource,
    bridgeInto: () => {},
    state$: new Subject(),
    errors$: new Subject(),
    dispose: () => {},
  };
  return { transport: transport as unknown as ITransport, subscribeToResource };
}

const noopContent = {
  getBinary: async () => ({ data: new ArrayBuffer(0), contentType: 'text/plain' }),
  getBinaryStream: async () => ({ stream: new ReadableStream(), contentType: 'text/plain' }),
  dispose: () => {},
} as unknown as IContentTransport;

/** Mimic one `useResourceLoader(client, rid)`: resource + annotations subscriptions. */
function mountLoader(browse: BrowseNamespace, rid: ResourceId) {
  const state = {
    resource: undefined as unknown,
    annotations: undefined as unknown,
    errors: [] as unknown[],
    get loaded() {
      return this.resource !== undefined && this.annotations !== undefined;
    },
  };
  const subs = [
    browse.resource(rid).subscribe({
      next: (v) => { if (v !== undefined) state.resource = v; },
      error: (e) => state.errors.push(e),
    }),
    browse.annotations(rid).subscribe({
      next: (v) => { if (v !== undefined) state.annotations = v; },
      error: (e) => state.errors.push(e),
    }),
  ];
  return { state, unmount: () => subs.forEach((s) => s.unsubscribe()) };
}

describe('N concurrent distinct-rid loaders at connect (starvation repro)', () => {
  const RIDS = ['res-1', 'res-2', 'res-3', 'res-4'].map(makeResourceId);

  it('all N loaders resolve — none starved, none errored', async () => {
    const bus = new EventBus();
    const { transport } = makeSingleScopeTransport();
    const browse = new BrowseNamespace(transport, bus, noopContent);

    const loaders = RIDS.map((rid) => mountLoader(browse, rid));
    await flush();

    for (const [i, loader] of loaders.entries()) {
      expect(loader.state.errors, `loader ${i} errored`).toEqual([]);
      expect(loader.state.loaded, `loader ${i} starved`).toBe(true);
    }

    loaders.forEach((l) => l.unmount());
    bus.destroy();
  });

  it('a loader whose first fetch fails recovers via the bounded SWR retry (B14)', async () => {
    const bus = new EventBus();
    const { transport } = makeSingleScopeTransport({ failFirstResourceFetchFor: 'res-3' });
    const browse = new BrowseNamespace(transport, bus, noopContent);

    const loaders = RIDS.map((rid) => mountLoader(browse, rid));
    await flush();

    for (const [i, loader] of loaders.entries()) {
      expect(loader.state.errors, `loader ${i} errored`).toEqual([]);
      expect(loader.state.loaded, `loader ${i} starved`).toBe(true);
    }

    loaders.forEach((l) => l.unmount());
    bus.destroy();
  });

  it('unmount/remount of a degraded loader keeps working (the "permanent per key" symptom)', async () => {
    const bus = new EventBus();
    const { transport } = makeSingleScopeTransport();
    const browse = new BrowseNamespace(transport, bus, noopContent);

    const loaders = RIDS.map((rid) => mountLoader(browse, rid));
    await flush();
    loaders.forEach((l) => l.unmount());

    // Remount just the previously-degraded loaders (2..N).
    const remounted = RIDS.slice(1).map((rid) => mountLoader(browse, rid));
    await flush();
    for (const [i, loader] of remounted.entries()) {
      expect(loader.state.errors, `remounted loader ${i} errored`).toEqual([]);
      expect(loader.state.loaded, `remounted loader ${i} starved`).toBe(true);
    }

    remounted.forEach((l) => l.unmount());
    bus.destroy();
  });
});
