/**
 * #847 Phase 4 — live-query freshness follows observation.
 *
 * Subscribing to a resource-scoped `browse.*(rId)` live query acquires that
 * resource's scope (via the transport's ref-counted `subscribeToResource`);
 * the last unsubscribe releases it. No consumer needs to call
 * `subscribeToResource` manually — freshness comes from observation.
 *
 * The one-shot `.fresh()` path acquires NO scope: it fetches fresh and
 * returns. Global queries (`entityTypes`, `tagSchemas`, `resources`) acquire
 * no scope either — they aren't resource-bound.
 *
 * MULTI-RESOURCE-SCOPE: the SDK calls `subscribeToResource(rId)` once per
 * resource-scoped subscription; the transport ref-counts per resource and
 * DISTINCT resources compose — N mounted loaders on N resources each hold
 * their own scope concurrently. The old single-slot contention state (and
 * withScope's degradation workaround) no longer exists.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { EventMap } from '@semiont/core';
import type { IContentTransport, ResourceId } from '@semiont/core';
import { readyValue } from '../cache';
import { BrowseNamespace } from '../namespaces/browse';
import { inMemoryTransport } from './helpers/in-memory-transport';
import { mockAnnotation } from './fixtures/annotation';
import { mockResource } from './fixtures/resource';

function makeFakeTransport() {
  // One typed bus: the transport streams from it and the test pushes into
  // it, so a reply fixture is checked against the channel's declared payload.
  const bus = new EventBus();

  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const subscribeToResource = vi.fn((_rId: ResourceId) => {
    const release = vi.fn();
    releases.push(release);
    return release;
  });

  // The result channel is NAMED, not derived by replacing '-requested' with
  // '-result' in the request's name. String surgery on channel names cannot
  // be checked against the registry, and the typed bus is what forced the
  // issue: `bus.get(<computed string>)` has no payload type to check against.
  const respond = <Req extends keyof EventMap, Res extends keyof EventMap>(
    channel: string,
    requestChannel: Req,
    resultChannel: Res,
    correlationId: string | undefined,
    reply: EventMap[Res],
  ) => {
    if (channel === requestChannel) {
      bus.emit(resultChannel, reply, { correlationId });
    }
  };

  const transport = inMemoryTransport({
    bus,
    subscribeToResource,
    onEmit: (channel, _payload, envelope) => {
      respond(channel as string, 'browse:annotations-requested', 'browse:annotations-result', envelope?.correlationId, { response: { annotations: [mockAnnotation('a1')], total: 1 } });
      respond(channel as string, 'browse:resource-requested', 'browse:resource-result', envelope?.correlationId, { response: { resource: mockResource('res-1'), annotations: [], entityReferences: [] } });
      respond(channel as string, 'browse:events-requested', 'browse:events-result', envelope?.correlationId, { response: { events: [], total: 0, resourceId: 'res-1' } });
      respond(channel as string, 'browse:referenced-by-requested', 'browse:referenced-by-result', envelope?.correlationId, { response: { referencedBy: [] } });
      respond(channel as string, 'browse:entity-types-requested', 'browse:entity-types-result', envelope?.correlationId, { response: { entityTypes: [] } });
    },
  });

  return { transport, subscribeToResource, releases };
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

  it('a one-shot .fresh() acquires no scope', async () => {
    await browse.annotations(rId).fresh();
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

describe('multi-scope: distinct-rid live queries COMPOSE — all fully live (MULTI-RESOURCE-SCOPE Step 6)', () => {
  // The old single-slot contract threw for a second distinct resourceId and
  // the interim (starvation-fix P2.5) degraded that loader to unscoped
  // observation. Both states are gone: N distinct-rid loaders at mount (the
  // embeddable-viewer "resource per chat message" pattern) each acquire
  // their OWN scope on the shared connection, keep it independently, and
  // release it independently. This is the plan's acceptance shape at the
  // namespace level; the browse-concurrent-loaders suite covers the same
  // over faulty wires.

  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  const rid1: ResourceId = makeResourceId('res-1');
  const rid2: ResourceId = makeResourceId('res-2');

  it('two distinct-rid live queries BOTH acquire their scopes — no throw, no degradation, both deliver', async () => {
    const bus = new EventBus();
    const { transport, subscribeToResource } = makeFakeTransport();
    const browse = new BrowseNamespace(transport, bus, noopContent);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const values1: unknown[] = [];
    const values2: unknown[] = [];
    const errors: unknown[] = [];

    browse.resource(rid1).subscribe({ next: (s) => values1.push(readyValue(s)), error: (e) => errors.push(e) });
    browse.resource(rid2).subscribe({ next: (s) => values2.push(readyValue(s)), error: (e) => errors.push(e) });
    await flush();

    expect(errors).toEqual([]);
    expect(values1.filter(Boolean)).toHaveLength(1);
    expect(values2.filter(Boolean)).toHaveLength(1);
    expect(subscribeToResource).toHaveBeenCalledWith(rid1);
    expect(subscribeToResource).toHaveBeenCalledWith(rid2);
    // The degradation breadcrumb is dead code — nothing may warn here.
    expect(warnSpy.mock.calls.map((c) => String(c[0])).filter((w) => w.includes('SCOPE-CONTENTION'))).toEqual([]);

    warnSpy.mockRestore();
    bus.destroy();
  });

  it('releases are per-resource: dropping one loader keeps the other scoped', async () => {
    const bus = new EventBus();
    const { transport, subscribeToResource, releases } = makeFakeTransport();
    const browse = new BrowseNamespace(transport, bus, noopContent);

    const sub1 = browse.resource(rid1).subscribe(() => {});
    const sub2 = browse.resource(rid2).subscribe(() => {});
    await flush();
    expect(subscribeToResource).toHaveBeenCalledTimes(2);

    sub1.unsubscribe();
    expect(releases[0]).toHaveBeenCalledTimes(1); // rid1's release only
    expect(releases[1]).not.toHaveBeenCalled();   // rid2 still held

    sub2.unsubscribe();
    expect(releases[1]).toHaveBeenCalledTimes(1);

    bus.destroy();
  });
});
