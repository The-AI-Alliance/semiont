/**
 * N distinct-rid loaders on one client — the MULTI-RESOURCE-SCOPE acceptance
 * shape at the `BrowseNamespace` level, mimicking `useResourceLoader` per
 * chat message (one `resource(rid)` + one `annotations(rid)` live query per
 * loader).
 *
 * History: this file began as the starvation repro
 * (.plans/bugs/concurrent-browse-resource-starvation.md — pre-fix, loaders
 * 2..N hit the single-slot `subscribeToResource` throw and starved forever;
 * the interim P2.5 degraded them to unscoped observation). Both states are
 * gone: distinct resources COMPOSE, so the contract pinned here is stronger —
 * every loader acquires its OWN scope, every loader is FULLY live (its own
 * resource's broadcast invalidations reach it, and only it), and nothing
 * warns. Loaded-ness is judged on `ready` CacheState emissions (D1) — a
 * `pending` emission must never count as loaded, or starvation detection
 * goes vacuous.
 */

import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { EventBus, resourceId as makeResourceId, annotationId } from '@semiont/core';
import type {
  ConnectionState,
  EventMetadata,
  EventOfType,
  IContentTransport,
  ITransport,
  ResourceId,
  StoredEvent,
  UserId,
} from '@semiont/core';
import { BrowseNamespace } from '../namespaces/browse';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Fake transport with the COMPOSING `subscribeToResource` contract (mirrors
 * post-MULTI-RESOURCE-SCOPE HttpTransport: per-resource ref-counts, distinct
 * resources independent) and synchronous correlated replies. Tracks held
 * scopes and a per-channel/per-rid request log so tests can assert scope
 * composition and invalidation fan-out. `failFirstResourceFetchFor` makes
 * the first `browse:resource-requested` emit for that rid reject — the B14
 * retry path.
 */
function makeComposingTransport(opts: { failFirstResourceFetchFor?: string } = {}) {
  const subjects = new Map<string, Subject<Record<string, unknown>>>();
  const subjectFor = (channel: string) => {
    let s = subjects.get(channel);
    if (!s) {
      s = new Subject<Record<string, unknown>>();
      subjects.set(channel, s);
    }
    return s;
  };

  const heldScopes = new Map<string, number>();
  const subscribeToResource = vi.fn((rId: ResourceId) => {
    const key = rId as string;
    heldScopes.set(key, (heldScopes.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (heldScopes.get(key) ?? 0) - 1;
      if (remaining > 0) heldScopes.set(key, remaining);
      else heldScopes.delete(key);
    };
  });

  /** One entry per request emit: `channel rid`. */
  const requests: string[] = [];
  let pendingFailure = opts.failFirstResourceFetchFor;

  const transport = {
    baseUrl: 'http://test',
    emit: async (channel: string, payload: Record<string, unknown>) => {
      const rid = payload.resourceId as string;
      if (channel === 'browse:resource-requested' || channel === 'browse:annotations-requested') {
        requests.push(`${channel} ${rid}`);
      }
      if (channel === 'browse:resource-requested') {
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
    state$: new BehaviorSubject<ConnectionState>('open'),
    errors$: new Subject(),
    dispose: () => {},
  };
  return { transport: transport as unknown as ITransport, subscribeToResource, heldScopes, requests };
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
      next: (st) => {
        if (st.status === 'ready') state.resource = st.value;
        else if (st.status === 'failed') state.errors.push(st.error);
      },
    }),
    browse.annotations(rid).subscribe({
      next: (st) => {
        if (st.status === 'ready') state.annotations = st.value;
        else if (st.status === 'failed') state.errors.push(st.error);
      },
    }),
  ];
  return { state, unmount: () => subs.forEach((s) => s.unsubscribe()) };
}

function fakeMarkAdded(rid: ResourceId): StoredEvent<EventOfType<'mark:added'>> {
  return {
    id: `evt-${rid}`,
    type: 'mark:added',
    resourceId: rid,
    userId: 'did:web:test:users:test' as UserId,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload: {
      annotation: {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: annotationId('ann-1'),
        motivation: 'commenting',
        created: '2026-01-01T00:00:00Z',
        target: { source: rid as string },
        body: [{ type: 'TextualBody', value: 'c', purpose: 'commenting' }],
      },
    },
    metadata: { sequenceNumber: 1 } as EventMetadata,
  };
}

describe('N concurrent distinct-rid loaders — all scoped, all fully live', () => {
  const RIDS = ['res-1', 'res-2', 'res-3', 'res-4'].map(makeResourceId);

  it('all N loaders resolve AND each holds its OWN scope — no contention state, no warns', async () => {
    const bus = new EventBus();
    const { transport, heldScopes } = makeComposingTransport();
    const browse = new BrowseNamespace(transport, bus, noopContent);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaders = RIDS.map((rid) => mountLoader(browse, rid));
    await flush();

    for (const [i, loader] of loaders.entries()) {
      expect(loader.state.errors, `loader ${i} errored`).toEqual([]);
      expect(loader.state.loaded, `loader ${i} starved`).toBe(true);
    }
    // Every resource's scope is held concurrently — the composed matrix.
    expect([...heldScopes.keys()].sort()).toEqual(['res-1', 'res-2', 'res-3', 'res-4']);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).filter((w) => w.includes('SCOPE-CONTENTION'))).toEqual([]);

    loaders.forEach((l) => l.unmount());
    expect(heldScopes.size).toBe(0); // every release is independent and effective
    warnSpy.mockRestore();
    bus.destroy();
  });

  it("KEYSTONE: a broadcast invalidation for rid-k refetches loader k's annotation list ONLY", async () => {
    const bus = new EventBus();
    const { transport, requests } = makeComposingTransport();
    const browse = new BrowseNamespace(transport, bus, noopContent);

    const loaders = RIDS.map((rid) => mountLoader(browse, rid));
    await flush();
    requests.length = 0; // only the invalidation-driven refetches count

    bus.get('mark:added').next(fakeMarkAdded(RIDS[1]!)); // res-2's broadcast
    await flush();

    expect(requests).toContain('browse:annotations-requested res-2');
    expect(requests.filter((r) => r.startsWith('browse:annotations-requested'))).toHaveLength(1);

    loaders.forEach((l) => l.unmount());
    bus.destroy();
  });

  it('a loader whose first fetch fails recovers via the bounded SWR retry (B14)', async () => {
    const bus = new EventBus();
    const { transport } = makeComposingTransport({ failFirstResourceFetchFor: 'res-3' });
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

  it('unmount/remount keeps working (the old "permanent per key" symptom stays dead)', async () => {
    const bus = new EventBus();
    const { transport } = makeComposingTransport();
    const browse = new BrowseNamespace(transport, bus, noopContent);

    const loaders = RIDS.map((rid) => mountLoader(browse, rid));
    await flush();
    loaders.forEach((l) => l.unmount());

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
