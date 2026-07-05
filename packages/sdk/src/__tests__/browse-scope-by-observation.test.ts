/**
 * #847 Phase 4 — live-query freshness follows observation.
 *
 * Subscribing to a resource-scoped `browse.*(rId)` live query acquires that
 * resource's scope (via the transport's ref-counted `subscribeToResource`);
 * the last unsubscribe releases it. No consumer needs to call
 * `subscribeToResource` manually — freshness comes from observation.
 *
 * The one-shot `await` path (Phase 2) acquires NO scope: it fetches fresh and
 * returns. Global queries (`entityTypes`, `tagSchemas`, `resources`) acquire
 * no scope either — they aren't resource-bound.
 *
 * Single-scope model is unchanged (multi-scope stays deferred): the SDK calls
 * `subscribeToResource(rId)` once per resource-scoped subscription and the
 * transport ref-counts them onto one SSE scope.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { IContentTransport, ITransport, ResourceId } from '@semiont/core';
import { BrowseNamespace } from '../namespaces/browse';

function makeFakeTransport() {
  const subjects = new Map<string, Subject<Record<string, unknown>>>();
  const subjectFor = (channel: string) => {
    let s = subjects.get(channel);
    if (!s) {
      s = new Subject<Record<string, unknown>>();
      subjects.set(channel, s);
    }
    return s;
  };

  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const subscribeToResource = vi.fn((_rId: ResourceId) => {
    const release = vi.fn();
    releases.push(release);
    return release;
  });

  const respond = (channel: string, resultChannel: string, payload: Record<string, unknown>, response: unknown) => {
    if (channel === resultChannel) {
      subjectFor(channel.replace('-requested', '-result')).next({
        correlationId: payload.correlationId as string,
        response,
      });
    }
  };

  const transport = {
    baseUrl: 'http://test',
    emit: async (channel: string, payload: Record<string, unknown>) => {
      respond(channel, 'browse:annotations-requested', payload, { annotations: [{ id: 'a1' }], total: 1 });
      respond(channel, 'browse:resource-requested', payload, { resource: { id: 'res-1' } });
      respond(channel, 'browse:events-requested', payload, { events: [] });
      respond(channel, 'browse:referenced-by-requested', payload, { referencedBy: [] });
      respond(channel, 'browse:entity-types-requested', payload, { entityTypes: [] });
    },
    stream: (channel: string): Observable<Record<string, unknown>> => subjectFor(channel).asObservable(),
    subscribeToResource,
    bridgeInto: () => {},
    state$: new Subject(),
    errors$: new Subject(),
    dispose: () => {},
  };

  return { transport: transport as unknown as ITransport, subscribeToResource, releases };
}

const noopContent = {
  getBinary: async () => ({ data: new ArrayBuffer(0), contentType: 'text/plain' }),
  getBinaryStream: async () => ({ stream: new ReadableStream(), contentType: 'text/plain' }),
  dispose: () => {},
} as unknown as IContentTransport;

describe('browse live-query subscription acquires the resource scope (#847 Phase 4)', () => {
  let bus: EventBus;
  let browse: BrowseNamespace;
  let subscribeToResource: ReturnType<typeof makeFakeTransport>['subscribeToResource'];
  let releases: ReturnType<typeof makeFakeTransport>['releases'];
  const rId: ResourceId = makeResourceId('res-1');

  beforeEach(() => {
    bus = new EventBus();
    const fake = makeFakeTransport();
    subscribeToResource = fake.subscribeToResource;
    releases = fake.releases;
    browse = new BrowseNamespace(fake.transport, bus, noopContent);
  });

  afterEach(() => {
    bus.destroy();
  });

  it('subscribing to browse.annotations(rId) acquires the scope; unsubscribe releases', () => {
    expect(subscribeToResource).not.toHaveBeenCalled();

    const sub = browse.annotations(rId).subscribe(() => {});
    expect(subscribeToResource).toHaveBeenCalledTimes(1);
    expect(subscribeToResource).toHaveBeenCalledWith(rId);
    expect(releases[0]).not.toHaveBeenCalled();

    sub.unsubscribe();
    expect(releases[0]).toHaveBeenCalledTimes(1);
  });

  it('a one-shot await acquires no scope', async () => {
    await browse.annotations(rId);
    expect(subscribeToResource).not.toHaveBeenCalled();
  });

  it('each resource-scoped live query acquires (the transport ref-counts them to one scope)', () => {
    const s1 = browse.resource(rId).subscribe(() => {});
    const s2 = browse.annotations(rId).subscribe(() => {});
    const s3 = browse.events(rId).subscribe(() => {});
    expect(subscribeToResource).toHaveBeenCalledTimes(3);
    expect(subscribeToResource).toHaveBeenCalledWith(rId);

    s1.unsubscribe();
    s2.unsubscribe();
    s3.unsubscribe();
    expect(releases.filter((r) => r.mock.calls.length > 0)).toHaveLength(3);
  });

  it('global queries acquire no scope', () => {
    const sub = browse.entityTypes().subscribe(() => {});
    expect(subscribeToResource).not.toHaveBeenCalled();
    sub.unsubscribe();
  });
});

describe('scope contention degrades to unscoped observation (concurrent-browse-resource-starvation)', () => {
  // HttpTransport is SINGLE-scope: `subscribeToResource` throws for a second
  // distinct resourceId while the first is held. N distinct-rid loaders at
  // mount (the embeddable-viewer "resource per chat message" pattern) hit
  // that throw on loaders 2..N — and an errored subscription starves its
  // component forever, silently. Scope acquisition failure must DEGRADE the
  // live query to unscoped observation (correlated replies are globally
  // bridged; only per-resource broadcast invalidations are scope-gated), not
  // error the stream. See .plans/bugs/concurrent-browse-resource-starvation.md.

  /** Fake transport with HttpTransport's single-scope contract. */
  function makeSingleScopeTransport() {
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
        throw new Error(
          `HttpTransport already subscribed to resource ${active.rId}; ` +
            `call the unsubscribe returned from the previous subscribeToResource before subscribing to ${rId}.`,
        );
      }
      if (active) active.refCount++;
      else active = { rId, refCount: 1 };
      return () => {
        if (active && --active.refCount <= 0) active = null;
      };
    });

    const transport = {
      baseUrl: 'http://test',
      emit: async (channel: string, payload: Record<string, unknown>) => {
        if (channel === 'browse:resource-requested') {
          subjectFor('browse:resource-result').next({
            correlationId: payload.correlationId as string,
            response: { resource: { '@id': payload.resourceId, name: `Resource ${payload.resourceId as string}` } },
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

  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  const rid1: ResourceId = makeResourceId('res-1');
  const rid2: ResourceId = makeResourceId('res-2');

  it('a second distinct-rid live query still delivers values when scope acquisition throws', async () => {
    const bus = new EventBus();
    const { transport } = makeSingleScopeTransport();
    const browse = new BrowseNamespace(transport, bus, noopContent);

    const values1: unknown[] = [];
    const values2: unknown[] = [];
    const errors2: unknown[] = [];

    // Loader 1 acquires the single scope; loader 2's acquisition throws.
    browse.resource(rid1).subscribe({ next: (v) => values1.push(v) });
    browse.resource(rid2).subscribe({ next: (v) => values2.push(v), error: (e) => errors2.push(e) });
    await flush();

    expect(errors2).toEqual([]); // NOT errored by the scope contention…
    expect(values2.filter(Boolean)).toHaveLength(1); // …and the value arrives (degraded/unscoped)
    expect(values1.filter(Boolean)).toHaveLength(1); // loader 1 unaffected

    bus.destroy();
  });

  it('degradation is per-subscription: once the scope frees, a new subscription acquires it', async () => {
    const bus = new EventBus();
    const { transport, subscribeToResource } = makeSingleScopeTransport();
    const browse = new BrowseNamespace(transport, bus, noopContent);

    const sub1 = browse.resource(rid1).subscribe(() => {});
    const sub2 = browse.resource(rid2).subscribe(() => {}); // degraded (contention)
    await flush();

    sub1.unsubscribe(); // scope freed
    sub2.unsubscribe();

    // A fresh subscription for rid2 now acquires the scope normally.
    subscribeToResource.mockClear();
    browse.resource(rid2).subscribe(() => {});
    expect(subscribeToResource).toHaveBeenCalledWith(rid2);
    expect(subscribeToResource).toHaveReturned(); // no throw this time

    bus.destroy();
  });
});
