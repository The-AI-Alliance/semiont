/**
 * The two live queries the Librarian answers: `match.resources()` (searching
 * resources by text) and `gather.referencedBy()` (what refers to a resource).
 *
 * They are cached like the queries of `browse`, and refreshed by the same
 * table (specs/src/client/refresh.json), each namespace acting on its own.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BehaviorSubject, filter, firstValueFrom, map, type Observable } from 'rxjs';
import { EventBus, resourceId } from '@semiont/core';
import type { ConnectionState, EventMap, EventMetadata, EventOfType, ResourceDescriptor, ResourceId, StoredEvent, UserId } from '@semiont/core';
import { isReady, type CacheState } from '../../cache';
import { GatherNamespace } from '../gather';
import { MatchNamespace } from '../match';
import { inMemoryTransport } from '../../__tests__/helpers/in-memory-transport';

const RID = resourceId('res-1');

const resource = (id: string): ResourceDescriptor => ({
  '@context': 'http://schema.org',
  '@id': resourceId(id),
  name: `Resource ${id}`,
  representations: [],
});

function ready<T>(obs: Observable<CacheState<T>>): Promise<T> {
  return firstValueFrom(obs.pipe(filter(isReady), map((s) => s.value)));
}

/** A transport that answers the two operations, counting what it was asked. */
function harness(matchKind: 'lexical' | 'semantic' = 'lexical') {
  const bus = new EventBus();
  const state$ = new BehaviorSubject<ConnectionState>('open');
  const asked: Array<{ channel: keyof EventMap; payload: unknown }> = [];
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const subscribeToResource = vi.fn((_rId: ResourceId) => {
    const release = vi.fn();
    releases.push(release);
    return release;
  });

  const transport = inMemoryTransport({
    bus,
    state$,
    subscribeToResource,
    onEmit: (channel, payload, envelope) => {
      const correlationId = envelope?.correlationId;
      if (channel === 'match:resources-requested') {
        asked.push({ channel, payload });
        queueMicrotask(() => bus.emit('match:resources-result', {
          response: { resources: [resource('res-hit')], total: 1, offset: 0, limit: 100, matchKind },
        }, { correlationId }));
      }
      if (channel === 'gather:referenced-by-requested') {
        asked.push({ channel, payload });
        queueMicrotask(() => bus.emit('gather:referenced-by-result', {
          response: { referencedBy: [] },
        }, { correlationId }));
      }
    },
  });

  const count = (channel: keyof EventMap) => asked.filter((a) => a.channel === channel).length;
  return { bus, state$, transport, asked, count, subscribeToResource, releases };
}

function created(rId: ResourceId): StoredEvent<EventOfType<'yield:created'>> {
  return {
    id: `evt-created-${rId}`,
    type: 'yield:created',
    resourceId: rId,
    userId: 'did:web:test:users:test' as UserId,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload: { name: `Imported ${rId}`, format: 'text/plain', contentChecksum: 'sha256-test' },
    metadata: { sequenceNumber: 1 } as EventMetadata,
  };
}

describe('match.resources()', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks the search with its filters, and the first hundred when none are given', async () => {
    const h = harness();
    const match = new MatchNamespace(h.transport, h.bus);

    await ready(match.resources('cat'));
    await ready(match.resources('cat', { archived: false, entityType: 'Person', limit: 5 }));

    expect(h.asked.map((a) => a.payload)).toEqual([
      { search: 'cat', archived: undefined, entityType: undefined, limit: 100, offset: 0 },
      { search: 'cat', archived: false, entityType: 'Person', limit: 5, offset: 0 },
    ]);
    match.dispose();
  });

  it('keeps one answer per search and set of filters', async () => {
    const h = harness();
    const match = new MatchNamespace(h.transport, h.bus);

    await ready(match.resources('foo'));
    await ready(match.resources('foo'));
    expect(h.count('match:resources-requested')).toBe(1);
    expect(match.resources('foo')).toBe(match.resources('foo'));

    await ready(match.resources('bar'));
    await ready(match.resources('foo', { entityType: 'Person' }));
    expect(h.count('match:resources-requested')).toBe(3);
    match.dispose();
  });

  it('the label and the resources it describes arrive as one value', async () => {
    const h = harness('semantic');
    const match = new MatchNamespace(h.transport, h.bus);

    // The one ready emission carries the label AND the page it labels —
    // there is no second observable to (mis)pair them from.
    const value = await ready(match.resources('kitten'));

    expect(value.matchKind).toBe('semantic');
    expect(value.resources.map((r) => r.name)).toEqual(['Resource res-hit']);
    match.dispose();
  });

  it('a resource created elsewhere asks every held search again, once per window', async () => {
    const h = harness();
    const match = new MatchNamespace(h.transport, h.bus, { invalidationWindowMs: 50 });
    await ready(match.resources('foo'));
    await ready(match.resources('bar'));

    h.bus.emit('yield:created', created(resourceId('res-new')));
    h.bus.emit('yield:created', created(resourceId('res-newer')));
    await vi.advanceTimersByTimeAsync(0);
    // The first runs at once; the second is owed to the window's close.
    expect(h.count('match:resources-requested')).toBe(4);

    await vi.advanceTimersByTimeAsync(50);
    expect(h.count('match:resources-requested')).toBe(6);
    match.dispose();
  });

  it('the stream open again after a drop asks every held search again', async () => {
    const h = harness();
    const match = new MatchNamespace(h.transport, h.bus, { invalidationWindowMs: 50 });
    await ready(match.resources('foo'));

    h.state$.next('reconnecting');
    h.state$.next('open');
    await vi.advanceTimersByTimeAsync(0);

    expect(h.count('match:resources-requested')).toBe(2);
    match.dispose();
  });

  it('a disposed namespace asks nothing more', async () => {
    const h = harness();
    const match = new MatchNamespace(h.transport, h.bus, { invalidationWindowMs: 50 });
    await ready(match.resources('foo'));

    match.dispose();
    h.bus.emit('yield:created', created(resourceId('res-new')));
    await vi.advanceTimersByTimeAsync(100);

    expect(h.count('match:resources-requested')).toBe(1);
  });
});

describe('gather.referencedBy()', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks the Librarian, once per resource, and gives the same observable per key', async () => {
    const h = harness();
    const gather = new GatherNamespace(h.transport, h.bus);

    expect(await ready(gather.referencedBy(RID))).toEqual([]);
    await ready(gather.referencedBy(RID));

    expect(h.asked).toEqual([{ channel: 'gather:referenced-by-requested', payload: { resourceId: RID } }]);
    expect(gather.referencedBy(RID)).toBe(gather.referencedBy(RID));
    expect(gather.referencedBy(RID)).not.toBe(gather.referencedBy(resourceId('res-2')));
    gather.dispose();
  });

  it('subscribing acquires the resource scope and unsubscribing releases it; a one-shot read acquires none', async () => {
    const h = harness();
    const gather = new GatherNamespace(h.transport, h.bus);

    await gather.referencedBy(RID);
    expect(h.subscribeToResource).not.toHaveBeenCalled();

    const sub = gather.referencedBy(RID).subscribe();
    expect(h.subscribeToResource).toHaveBeenCalledWith(RID);
    sub.unsubscribe();
    expect(h.releases[0]).toHaveBeenCalledTimes(1);
    gather.dispose();
  });

  it('a gap in what the scope replayed asks again for the resource it names, and no other', async () => {
    const h = harness();
    const gather = new GatherNamespace(h.transport, h.bus, { invalidationWindowMs: 50 });
    const other = resourceId('res-2');
    const held = gather.referencedBy(RID);
    await ready(held);
    await ready(gather.referencedBy(other));

    h.bus.emit('bus:resume-gap', { scope: RID, lastSeenId: `p-${RID}-1`, reason: 'query-error' });
    // A resource nothing asked about has nothing to refresh.
    h.bus.emit('bus:resume-gap', { scope: resourceId('res-3'), lastSeenId: 'p-res-3-1', reason: 'query-error' });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.asked.map((a) => a.payload)).toEqual([{ resourceId: RID }, { resourceId: other }, { resourceId: RID }]);
    // The observable a subscriber holds is the one that carries the new answer.
    expect(gather.referencedBy(RID)).toBe(held);
    gather.dispose();
  });
});
