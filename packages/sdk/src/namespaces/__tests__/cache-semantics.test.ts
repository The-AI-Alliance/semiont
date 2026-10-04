/**
 * Cache-semantics contract tests.
 *
 * Enumerates behaviors B1–B16, B19 and B20 from
 * `docs/protocol/CACHE-SEMANTICS.md` against `BrowseNamespace`.
 *
 * Each `describe` block is tagged with the behavior number it verifies.
 * Adding a behavior to the spec must add a test here; changing one must
 * update both.
 */

import { describe, it, expect, vi } from 'vitest';
import { map, firstValueFrom, filter, BehaviorSubject } from 'rxjs';
import { EventBus, INVALIDATION_WINDOW_MS, resourceId, annotationId } from '@semiont/core';
import type { components, StoredEvent, EventOfType, EventMetadata, UserId, ResourceId, EventMap } from '@semiont/core';
import type { ConnectionState } from '@semiont/core';
import { BrowseNamespace } from '../browse';
import { isReady, readyValue, type CacheState } from '../../cache';
import type { IContentTransport } from '@semiont/core';

import type { Annotation } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';
import { inMemoryTransport } from '../../__tests__/helpers/in-memory-transport';

const TEST_USER_ID = 'did:web:test:users:test' as UserId;
const TEST_METADATA = { sequenceNumber: 1 } as EventMetadata;

function mockAnnotation(id: string, source = 'res-1'): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(id),
    motivation: 'commenting',
    created: '2026-01-01T00:00:00Z',
    target: { source: resourceId(source) },
    body: [{ type: 'TextualBody', value: 'test comment', purpose: 'commenting' }],
  };
}

function mockResource(id: string, name?: string): ResourceDescriptor {
  return { '@context': 'http://schema.org', '@id': resourceId(id), name: name ?? `Resource ${id}`, representations: [] };
}

/**
 * Build a fully-typed StoredEvent for the bus channels BrowseNamespace
 * subscribes to. Tests only care about the fields the handler reads
 * (resourceId, payload.annotation); the rest is filled out to satisfy
 * the schema without `as any` casts.
 */
function fakeMarkAdded(rId: ResourceId, annIdStr: string): StoredEvent<EventOfType<'mark:added'>> {
  return {
    id: `evt-${annIdStr}`,
    type: 'mark:added',
    resourceId: rId,
    userId: TEST_USER_ID,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload: { annotation: mockAnnotation(annIdStr) },
    metadata: TEST_METADATA,
  };
}

function fakeYieldCreated(rId: ResourceId): StoredEvent<EventOfType<'yield:created'>> {
  return {
    id: `evt-created-${rId}`,
    type: 'yield:created',
    resourceId: rId,
    userId: TEST_USER_ID,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload: { name: `Imported ${rId}`, format: 'text/plain', contentChecksum: 'sha256-test' },
    metadata: TEST_METADATA,
  };
}

function fakeMarkRemoved(rId: ResourceId, annIdStr: string): StoredEvent<EventOfType<'mark:removed'>> {
  return {
    id: `evt-${annIdStr}-removed`,
    type: 'mark:removed',
    resourceId: rId,
    userId: TEST_USER_ID,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload: { annotationId: annotationId(annIdStr) },
    metadata: TEST_METADATA,
  };
}

function fakeMarkBodyUpdated(
  rId: ResourceId,
  updated: Annotation,
): EventMap['mark:body-updated'] {
  return {
    id: `evt-${updated.id}-body-updated`,
    type: 'mark:body-updated',
    resourceId: rId,
    userId: TEST_USER_ID,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    // The body describes ops, not the final annotation; the EventStore's
    // enrichment carries that at the top level. Unenriched here — callers
    // add `annotation` when the case under test has one.
    payload: { annotationId: updated.id, operations: [] },
    metadata: TEST_METADATA,
  };
}

function fakeBusResumeGap(scope: string, reason: EventMap['bus:resume-gap']['reason']): EventMap['bus:resume-gap'] {
  return { scope: resourceId(scope), lastSeenId: `p-${scope}-1`, reason };
}

/** The stream drops and is open again: the states a drop reports, and a handoff never does. */
function reopen(state$: BehaviorSubject<ConnectionState>): void {
  state$.next('reconnecting');
  state$.next('connecting');
  state$.next('open');
}

/**
 * The Browser's P2 reply, verbatim shape:
 * `{ agents: CollaboratorEntry[] }` where an entry is
 * `{ agent, servesJobTypes?, limits? }` — `limits` joined the entry with
 * INFERENCE-LIMITS-EXPOSURE P2, and the deep-equal passthrough pin below
 * is what proves discovered ceilings survive the cache round-trip
 * unreshaped. One worker agent WITH capabilities and ceilings, one
 * actors-only agent WITHOUT either — both pass through as-is (no
 * flattening to Agent[]).
 */
const MOCK_COLLABORATORS = [
  {
    agent: {
      '@type': 'Software',
      '@id': 'did:web:kb.test:agents:anthropic:claude-haiku-4-5',
      name: 'anthropic claude-haiku-4-5',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    },
    servesJobTypes: ['reference-annotation', 'generation'],
  },
  {
    agent: {
      '@type': 'Software',
      '@id': 'did:web:kb.test:agents:anthropic:claude-sonnet-4-5',
      name: 'anthropic claude-sonnet-4-5',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    },
    // actors-only (gatherer/matcher): no servesJobTypes — must stay absent.
  },
];

/**
 * What each key holder reports: the worker for the model its jobs use, the
 * librarian's matcher for the actor-only model, and a gatherer that reports
 * nothing.
 */
const HAIKU_LIMITS = { contextTokens: 200_000, maxOutputTokens: 64_000 };
const SONNET_LIMITS = { contextTokens: 200_000, maxOutputTokens: 32_000 };
const MOCK_LIMITS: Record<string, unknown[]> = {
  'job:limits-requested': [{ provider: 'anthropic', model: 'claude-haiku-4-5', limits: HAIKU_LIMITS }],
  'match:limits-requested': [{ provider: 'anthropic', model: 'claude-sonnet-4-5', limits: SONNET_LIMITS }],
  'gather:limits-requested': [],
};

/**
 * Test harness: a mock ActorStateUnit whose responses are parameterized so
 * individual tests can control timing, delay, and error behavior.
 */
interface HarnessOptions {
  resourceName?: (id: string) => string;
  /** Number of `mark:added` annotations on the server right now. */
  annotationCountAfterReset?: number;
  /** If set, cause the next N fetches to reject. */
  rejectNext?: number;
  /** State subject so tests can drive reconnect-lifecycle behavior. */
  state$?: BehaviorSubject<ConnectionState>;
  /** Channels the harness never answers — for timeout-path tests. */
  silentChannels?: string[];
  /** Threaded to BrowseNamespace so timeout tests run on short real time. */
  busTimeoutMs?: number;
}

function createHarness(opts: HarnessOptions = {}) {
  const transportBus = new EventBus();
  const state = {
    resourceName: opts.resourceName ?? ((id: string) => `Resource ${id}`),
    rejectRemaining: opts.rejectNext ?? 0,
    annotationCount: opts.annotationCountAfterReset ?? 1,
  };
  const silentChannels = opts.silentChannels ?? [];

  const emitSpy = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>, envelope?: { correlationId?: string }) => {
    const correlationId = envelope?.correlationId as string;
    if (silentChannels.includes(channel)) return; // request swallowed — no reply ever

    let resultChannel: string;
    let response: Record<string, unknown>;

    switch (channel) {
      case 'browse:resource-requested': {
        resultChannel = 'browse:resource-result';
        const id = (payload.resourceId as string) ?? 'res-1';
        response = { resource: mockResource(id, state.resourceName(id)), annotations: [], entityReferences: [] };
        break;
      }
      case 'browse:resources-requested': {
        resultChannel = 'browse:resources-result';
        response = { resources: [mockResource('res-1')], total: 1, offset: 0, limit: 20, matchKind: 'lexical' };
        break;
      }
      case 'browse:annotations-requested': {
        resultChannel = 'browse:annotations-result';
        const annotations: Annotation[] = [];
        for (let i = 0; i < state.annotationCount; i++) annotations.push(mockAnnotation(`ann-${i + 1}`));
        response = { annotations, total: annotations.length };
        break;
      }
      case 'browse:annotation-requested': {
        resultChannel = 'browse:annotation-result';
        const id = payload.annotationId as string;
        response = { annotation: mockAnnotation(id), resource: null, resolvedResource: null };
        break;
      }
      case 'browse:entity-types-requested': {
        resultChannel = 'browse:entity-types-result';
        response = { entityTypes: ['Person'] };
        break;
      }
      case 'browse:referenced-by-requested': {
        resultChannel = 'browse:referenced-by-result';
        response = { referencedBy: [] };
        break;
      }
      case 'browse:events-requested': {
        resultChannel = 'browse:events-result';
        response = { events: [], total: 0, resourceId: (payload.resourceId as string) ?? 'res-1' };
        break;
      }
      case 'browse:agents-requested': {
        resultChannel = 'browse:agents-result';
        response = { agents: MOCK_COLLABORATORS };
        break;
      }
      case 'job:limits-requested':
      case 'gather:limits-requested':
      case 'match:limits-requested': {
        resultChannel = channel.replace('-requested', '-result');
        response = { limits: MOCK_LIMITS[channel] };
        break;
      }
      default:
        return;
    }

    if (state.rejectRemaining > 0) {
      state.rejectRemaining--;
      queueMicrotask(() => {
        transportBus.emit(
          resultChannel.replace('-result', '-failed') as never,
          ({ message: 'rejected by test' }) as never,
          { correlationId },
        );
      });
    } else {
      queueMicrotask(() => {
        transportBus.emit(resultChannel as never, { response } as never, { correlationId });
      });
    }
  });

  const subscribeToResource = vi.fn().mockReturnValue(() => {});
  const transport = inMemoryTransport({
    bus: transportBus,
    subscribeToResource,
    state$: (opts.state$ ?? new BehaviorSubject<ConnectionState>('open')).asObservable(),
    onEmit: (channel, payload, envelope) => {
      void emitSpy(channel, payload, envelope);
    },
  });

  const content: IContentTransport = {
    putBinary: vi.fn(),
    getBinary: vi.fn(),
    getBinaryStream: vi.fn(),
    getResourceGraph: vi.fn(),
    dispose: vi.fn(),
  };

  const eventBus = new EventBus();
  const browse = new BrowseNamespace(
    transport,
    eventBus,
    content,
    opts.busTimeoutMs !== undefined ? { busTimeoutMs: opts.busTimeoutMs } : undefined,
  );

  return { browse, eventBus, emitSpy, state };
}

function firstDefined<T>(obs: import('rxjs').Observable<import('../../cache').CacheState<T>>): Promise<T> {
  return firstValueFrom(obs.pipe(filter(isReady), map((s) => s.value)));
}

// Tick past queued microtasks so values propagate.
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('Cache semantics — behaviors B1–B16 against BrowseNamespace', () => {
  const RID = resourceId('res-1');
  const AID = annotationId('ann-1');

  describe('B1 — first observation triggers a fetch', () => {
    it('`resource(id)` emits the fetched value after an initial undefined', async () => {
      const { browse, emitSpy } = createHarness();
      const val = await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(val).toMatchObject({ name: 'Resource res-1' });
    });
  });

  describe('B2 — subsequent observations reuse the cached value', () => {
    it('no second fetch on re-subscribe', async () => {
      const { browse, emitSpy } = createHarness();
      await firstDefined(browse.resource(RID));
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('B3 — concurrent first observations deduplicate', () => {
    it('two simultaneous subscribes issue exactly one fetch', () => {
      const { browse, emitSpy } = createHarness();
      browse.resource(RID).subscribe(() => {});
      browse.resource(RID).subscribe(() => {});
      expect(emitSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('B4 — observers share one observable per key', () => {
    it('returns referentially-equal observables for the same key', () => {
      const { browse } = createHarness();
      const a = browse.resource(RID);
      const b = browse.resource(RID);
      expect(a).toBe(b);
    });

    // Identity coverage for every live-query method. Absence of this
    // coverage previously hid a regression in `annotations()` where the
    // transformed observable (`.pipe(map(r => r?.annotations))`) was
    // rebuilt on every call. React consumers that compare observable
    // identity re-subscribe on every render when B4 breaks.
    it('resources(): identical for same filter; different for different filter', () => {
      const { browse } = createHarness();
      const a = browse.resources({ limit: 10 });
      const b = browse.resources({ limit: 10 });
      expect(a).toBe(b);
      const c = browse.resources({ limit: 20 });
      expect(a).not.toBe(c);
    });

    it('annotations(): identical for same resourceId', () => {
      const { browse } = createHarness();
      const a = browse.annotations(RID);
      const b = browse.annotations(RID);
      expect(a).toBe(b);
    });

    it('annotation(): identical for same annotationId regardless of resourceId', () => {
      const { browse } = createHarness();
      const RID2 = resourceId('res-2');
      const a = browse.annotation(RID, AID);
      const b = browse.annotation(RID, AID);
      expect(a).toBe(b);
      // The cache is keyed by annotationId alone, so the same annotation
      // observed through a different resourceId returns the same observable.
      const c = browse.annotation(RID2, AID);
      expect(a).toBe(c);
    });

    it('entityTypes(): identical across calls', () => {
      const { browse } = createHarness();
      const a = browse.entityTypes();
      const b = browse.entityTypes();
      expect(a).toBe(b);
    });

    it('referencedBy(): identical for same resourceId', () => {
      const { browse } = createHarness();
      const a = browse.referencedBy(RID);
      const b = browse.referencedBy(RID);
      expect(a).toBe(b);
    });

    it('events(): identical for same resourceId', () => {
      const { browse } = createHarness();
      const a = browse.events(RID);
      const b = browse.events(RID);
      expect(a).toBe(b);
    });
  });

  describe('B5 — fetch success updates the store atomically', () => {
    it('observers never see a transient undefined around the success write', async () => {
      const { browse } = createHarness();
      const seen: Array<ResourceDescriptor | undefined> = [];
      browse.resource(RID).subscribe((s) => seen.push(readyValue(s)));
      await firstDefined(browse.resource(RID));
      // The only undefined should be the initial emission before the fetch resolves.
      // Subsequent values should be defined; no undefined-after-defined transitions.
      const definedSeenAfterFirst = seen.slice(1);
      expect(definedSeenAfterFirst.every((v) => v !== undefined)).toBe(true);
    });
  });

  describe('B6 — fetch failure leaves the previous state intact', () => {
    it('value-less key: first-fetch exhaustion errors the observer (B15); guard + marker released', async () => {
      // Two rejections exhaust the observe attempt + its B14 retry. Post-B15
      // the value-less terminal failure is an error notification to this
      // key's observers — not `undefined` forever (LIVENESS-AXIOMS L1).
      const { browse, emitSpy, state } = createHarness({ rejectNext: 2 });
      const states: string[] = [];
      browse.resource(RID).subscribe((s) => states.push(s.status));
      await flush();
      // D1: the terminal failure is a `failed` EMISSION through withScope +
      // CacheObservable — never a stream error, never silence.
      expect(states).toEqual(['pending', 'failed']);
      expect(emitSpy).toHaveBeenCalledTimes(2); // attempt + B14 retry, then idle

      // Guard + marker released: a subsequent fetch succeeds and a fresh
      // subscription (the errored one is terminal) sees it.
      state.rejectRemaining = 0;
      browse.invalidateResourceDetail(RID);
      const val = await firstDefined(browse.resource(RID));
      expect(val).toMatchObject({ name: 'Resource res-1' });
    });

    it('previously-fresh value survives a failed refetch', async () => {
      const { browse, emitSpy, state } = createHarness();
      const first = await firstDefined(browse.resource(RID));
      expect(first).toMatchObject({ name: 'Resource res-1' });

      // Two rejections exhaust the invalidate refetch + its B14 retry.
      state.rejectRemaining = 2;
      browse.invalidateResourceDetail(RID);
      await flush();

      // Stale value is still served; no transient undefined.
      const latest = await firstDefined(browse.resource(RID));
      expect(latest).toMatchObject({ name: 'Resource res-1' });
      expect(emitSpy).toHaveBeenCalledTimes(3); // initial + refetch + B14 retry
    });
  });

  describe('B7 — invalidate is stale-while-revalidate', () => {
    it('observer keeps seeing the stale value during the refetch — no undefined flash', async () => {
      const { browse, state } = createHarness();
      const seen: Array<ResourceDescriptor | undefined> = [];
      browse.resource(RID).subscribe((s) => seen.push(readyValue(s)));
      await firstDefined(browse.resource(RID));

      // Change the server-side response.
      state.resourceName = (id: string) => `Updated ${id}`;
      const beforeInvalidate = [...seen];
      browse.invalidateResourceDetail(RID);

      // Immediately after invalidate, no new emission should have happened.
      expect(seen.length).toBe(beforeInvalidate.length);

      await flush();
      const last = seen[seen.length - 1];
      expect(last).toMatchObject({ name: 'Updated res-1' });

      // No emission at any point was `undefined` after the first.
      const defineds = seen.slice(1);
      expect(defineds.every((v) => v !== undefined)).toBe(true);
    });

    it('clears the in-flight guard before refetching (commit 845c6b24 regression)', async () => {
      // Scenario: a fetch is stuck in-flight (guard never cleared). If
      // invalidate does not clear the guard, the refetch short-circuits.
      // Two rejections exhaust the observe attempt + its B14 retry first.
      const { browse, emitSpy, state } = createHarness({ rejectNext: 2 });
      const seen: Array<ResourceDescriptor | undefined> = [];
      // Value-less exhaustion emits `failed` to this subscriber (B15/D1) —
      // projected to undefined here; this test is about the in-flight guard,
      // not the notification.
      browse.resource(RID).subscribe({ next: (s) => seen.push(readyValue(s)), error: () => {} });
      await flush(); // Attempt + B14 retry both reject; guard releases in finally.

      state.rejectRemaining = 0;
      browse.invalidateResourceDetail(RID);
      const val = await firstDefined(browse.resource(RID));
      expect(val).toBeDefined();
      expect(emitSpy).toHaveBeenCalledTimes(3); // attempt + retry + invalidate refetch
    });
  });

  describe('B8 — invalidate of an empty key is valid', () => {
    it('triggers a fetch and an observer sees the resulting value', async () => {
      const { browse, emitSpy } = createHarness();
      // No prior observation.
      browse.invalidateResourceDetail(RID);
      const val = await firstDefined(browse.resource(RID));
      // One fetch from invalidate; the subsequent observe hits the cached value.
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(val).toBeDefined();
    });
  });

  describe('B9 — invalidate during in-flight fetch does NOT coalesce', () => {
    it('a second invalidate while fetching starts a second fetch (orphan recovery)', () => {
      const { browse, emitSpy } = createHarness();
      browse.resource(RID).subscribe(() => {});
      expect(emitSpy).toHaveBeenCalledTimes(1);
      // Invalidate before the first fetch resolves. Must issue a new fetch
      // so an orphaned in-flight (SSE torn down) can't deadlock the cache.
      browse.invalidateResourceDetail(RID);
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('last-write-wins when both fetches resolve', async () => {
      const { browse, state } = createHarness();
      browse.resource(RID).subscribe(() => {});
      state.resourceName = () => 'First';
      // Fire a second fetch; responses come back in order.
      browse.invalidateResourceDetail(RID);
      state.resourceName = () => 'Second';
      browse.invalidateResourceDetail(RID);
      await flush();
      const val = await firstDefined(browse.resource(RID));
      expect(val).toMatchObject({ name: 'Second' });
    });
  });

  describe('B10 — multiple keys are independent', () => {
    it('invalidating key A does not affect key B', async () => {
      const { browse, emitSpy } = createHarness();
      const RID_A = resourceId('res-A');
      const RID_B = resourceId('res-B');
      await firstDefined(browse.resource(RID_A));
      await firstDefined(browse.resource(RID_B));
      expect(emitSpy).toHaveBeenCalledTimes(2);

      browse.invalidateResourceDetail(RID_A);
      // Only one additional emit (for A).
      expect(emitSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('B11 — per-cache observer observables live for the cache lifetime', () => {
    it('resource(): stable across invalidation', async () => {
      const { browse } = createHarness();
      const obs = browse.resource(RID);
      await firstDefined(obs);
      browse.invalidateResourceDetail(RID);
      await flush();
      expect(browse.resource(RID)).toBe(obs);
    });

    it('resources(): stable across invalidateResourceLists', async () => {
      const { browse } = createHarness();
      const obs = browse.resources({ limit: 10 });
      await firstDefined(obs);
      browse.invalidateResourceLists();
      await flush();
      expect(browse.resources({ limit: 10 })).toBe(obs);
    });

    it('annotations(): stable across invalidateAnnotationList', async () => {
      const { browse } = createHarness();
      const obs = browse.annotations(RID);
      await firstDefined(obs);
      browse.invalidateAnnotationList(RID);
      await flush();
      expect(browse.annotations(RID)).toBe(obs);
    });

    it('annotation(): stable across removeAnnotationDetail', async () => {
      const { browse } = createHarness();
      const obs = browse.annotation(RID, AID);
      await firstDefined(obs);
      browse.removeAnnotationDetail(AID);
      await flush();
      expect(browse.annotation(RID, AID)).toBe(obs);
    });

    it('entityTypes(): stable across invalidateEntityTypes', async () => {
      const { browse } = createHarness();
      const obs = browse.entityTypes();
      await firstDefined(obs);
      browse.invalidateEntityTypes();
      await flush();
      expect(browse.entityTypes()).toBe(obs);
    });

    it('referencedBy(): stable across invalidateReferencedBy', async () => {
      const { browse } = createHarness();
      const obs = browse.referencedBy(RID);
      await firstDefined(obs);
      browse.invalidateReferencedBy(RID);
      await flush();
      expect(browse.referencedBy(RID)).toBe(obs);
    });

    it('events(): stable across invalidateResourceEvents', async () => {
      const { browse } = createHarness();
      const obs = browse.events(RID);
      await firstDefined(obs);
      browse.invalidateResourceEvents(RID);
      await flush();
      expect(browse.events(RID)).toBe(obs);
    });
  });

  describe('B12 — bus-event handlers are additive', () => {
    it('mark:added + mark:removed are independent events on annotationList', async () => {
      vi.useFakeTimers();
      try {
        const { browse, eventBus, emitSpy } = createHarness();
        await firstDefined(browse.annotations(RID));
        await firstDefined(browse.events(RID));
        expect(emitSpy).toHaveBeenCalledTimes(2);
        emitSpy.mockClear();

        eventBus.emit('mark:added', fakeMarkAdded(RID, AID));
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).toHaveBeenCalledTimes(2); // annotations + events refetched

        eventBus.emit('mark:removed', fakeMarkRemoved(RID, AID));
        // Each is independent; mark:removed also fires annotations + events
        // refetch — owed to the window mark:added opened on those keys (B19).
        await vi.advanceTimersByTimeAsync(INVALIDATION_WINDOW_MS);
        expect(emitSpy).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('B13 — a stream that reopens', () => {
    const requests = (emitSpy: ReturnType<typeof createHarness>['emitSpy'], channel: string) =>
      emitSpy.mock.calls.filter(([ch]) => ch === channel).length;

    it('after a drop, asks again for what events without a position feed, and not for what a scope replays', async () => {
      const state$ = new BehaviorSubject<ConnectionState>('open');
      const { browse, emitSpy } = createHarness({ state$ });

      await firstDefined(browse.resource(RID));
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.resources());
      await firstDefined(browse.entityTypes());
      expect(emitSpy).toHaveBeenCalledTimes(4);

      reopen(state$);
      await flush();

      // `yield:*` and `frame:*` reach every client with no position: what was
      // published while the stream was down is lost, and nothing replays it.
      expect(requests(emitSpy, 'browse:resource-requested')).toBe(2);
      expect(requests(emitSpy, 'browse:resources-requested')).toBe(2);
      expect(requests(emitSpy, 'browse:entity-types-requested')).toBe(2);
      // A scope's own events are replayed from where the client left off.
      expect(requests(emitSpy, 'browse:annotations-requested')).toBe(1);
    });

    it('asks for nothing it does not hold (B20)', async () => {
      const state$ = new BehaviorSubject<ConnectionState>('open');
      const { browse, emitSpy } = createHarness({ state$ });
      await firstDefined(browse.annotations(RID));

      reopen(state$);
      await flush();

      expect(emitSpy).toHaveBeenCalledTimes(1);
    });

    it('asks for nothing while the state stays open, which is all a handoff shows', async () => {
      const state$ = new BehaviorSubject<ConnectionState>('open');
      const { browse, emitSpy } = createHarness({ state$ });
      await firstDefined(browse.resource(RID));
      await firstDefined(browse.resources());

      state$.next('open');
      await flush();

      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('asks for nothing more at the first open: there was no stream to miss anything on', async () => {
      const state$ = new BehaviorSubject<ConnectionState>('initial');
      const { browse, emitSpy } = createHarness({ state$ });
      const sub = browse.resources().subscribe(() => {});

      state$.next('connecting');
      state$.next('open');
      await firstDefined(browse.resources());
      await flush();

      // The one request the observer itself cost, which waited for the stream.
      expect(requests(emitSpy, 'browse:resources-requested')).toBe(1);
      sub.unsubscribe();
    });

    it('`bus:resume-gap` asks again for what is held of that scope, and of nothing else', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      const RID_A = resourceId('res-A');
      const RID_B = resourceId('res-B');
      const AID_A = annotationId('ann-A');
      await firstDefined(browse.resource(RID_A));
      await firstDefined(browse.annotations(RID_A));
      await firstDefined(browse.annotation(RID_A, AID_A));
      await firstDefined(browse.resource(RID_B));
      await firstDefined(browse.annotation(RID_B, AID));
      await firstDefined(browse.entityTypes());
      expect(emitSpy).toHaveBeenCalledTimes(6);

      eventBus.emit('bus:resume-gap', fakeBusResumeGap(RID_A, 'retention-exceeded'));
      await flush();

      const asked = emitSpy.mock.calls.slice(6).map(([channel, payload]) => [channel, payload]);
      expect(asked).toHaveLength(3);
      expect(asked).toContainEqual(['browse:resource-requested', { resourceId: RID_A }]);
      expect(asked).toContainEqual(['browse:annotations-requested', { resourceId: RID_A }]);
      // The scope's annotations too: its events are what feed them.
      expect(asked).toContainEqual(['browse:annotation-requested', { resourceId: RID_A, annotationId: AID_A }]);
    });
  });

  describe('B13a — an annotation that is gone', () => {
    it('fails its observers as not-found, and asks for nothing', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      const seen: CacheState<Annotation>[] = [];
      const sub = browse.annotation(RID, AID).subscribe((s) => seen.push(s));
      await firstDefined(browse.annotation(RID, AID));
      expect(emitSpy).toHaveBeenCalledTimes(1);

      // mark:delete-ok → remove path.
      const deleteOkPayload: components['schemas']['MarkDeleteOk'] = { response: { annotationId: AID } };
      eventBus.emit('mark:delete-ok', deleteOkPayload);
      await flush();

      const last = seen.at(-1)!;
      expect(last.status).toBe('failed');
      expect(last.status === 'failed' && last.error).toMatchObject({ code: 'bus.not-found' });
      // Never `pending` on the way: no request stands behind a removal.
      expect(seen.map((s) => s.status)).toEqual(['pending', 'ready', 'failed']);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      sub.unsubscribe();
    });

    it('an observer arriving afterwards asks the service', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      await firstDefined(browse.annotation(RID, AID));
      eventBus.emit('mark:delete-ok', { response: { annotationId: AID } });
      await flush();

      await firstDefined(browse.annotation(RID, AID));
      expect(emitSpy.mock.calls.filter(([ch]) => ch === 'browse:annotation-requested')).toHaveLength(2);
    });

    it('marks nothing about an annotation the client never asked for (B20)', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      eventBus.emit('mark:delete-ok', { response: { annotationId: AID } });
      await flush();

      // Its first observer is simply the first: pending, one request, ready.
      const seen: string[] = [];
      const sub = browse.annotation(RID, AID).subscribe((s) => seen.push(s.status));
      await firstDefined(browse.annotation(RID, AID));
      expect(seen).toEqual(['pending', 'ready']);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      sub.unsubscribe();
    });
  });

  describe('B13c — an unenriched body update revalidates instead of going stale', () => {
    it('asks again for the annotation itself, and goes on showing what it has', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      const seen: string[] = [];
      const sub = browse.annotation(RID, AID).subscribe((s) => seen.push(s.status));
      await firstDefined(browse.annotation(RID, AID));

      eventBus.emit('mark:body-updated', fakeMarkBodyUpdated(RID, mockAnnotation(AID, 'res-1')));
      await flush();

      expect(emitSpy.mock.calls.filter(([ch]) => ch === 'browse:annotation-requested')).toHaveLength(2);
      // The update is not a removal: the value stays until the new one arrives.
      expect(seen).not.toContain('failed');
      expect(seen.filter((status) => status === 'pending')).toHaveLength(1);
      sub.unsubscribe();
    });

    it('refetches the list when mark:body-updated arrives without its annotation', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      // An active observer, so invalidation revalidates (B7).
      const sub = browse.annotations(RID).subscribe(() => {});
      await firstDefined(browse.annotations(RID));
      const listFetches = () => emitSpy.mock.calls.filter(([ch]) => ch === 'browse:annotations-requested').length;
      const before = listFetches();

      // No top-level `annotation`: the enricher declined, so there is nothing to
      // write through. Returning early left the old body on screen.
      eventBus.emit('mark:body-updated', fakeMarkBodyUpdated(RID, mockAnnotation(AID, 'res-1')));
      await flush();

      expect(listFetches()).toBeGreaterThan(before);
      sub.unsubscribe();
    });
  });

  describe('B20 — a bus event refreshes only what the cache holds', () => {
    const requests = (emitSpy: ReturnType<typeof createHarness>['emitSpy'], channel: string) =>
      emitSpy.mock.calls.filter(([ch]) => ch === channel).length;

    it('an event on an observed resource costs no request for what nothing has asked for', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      const sub = browse.annotations(RID).subscribe(() => {});
      await firstDefined(browse.annotations(RID));

      eventBus.emit('mark:added', fakeMarkAdded(RID, AID));
      await flush();

      expect(requests(emitSpy, 'browse:annotations-requested'), 'the observed list is refreshed').toBe(2);
      expect(requests(emitSpy, 'browse:events-requested'), 'the event history nobody asked for is not').toBe(0);
      sub.unsubscribe();
    });

    it('a bulk import costs a viewer no request for the resources it has never looked at', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      const sub = browse.resources().subscribe(() => {});
      await firstDefined(browse.resources());

      for (let i = 0; i < 100; i++) eventBus.emit('yield:created', fakeYieldCreated(resourceId(`imported-${i}`)));
      await flush();

      expect(requests(emitSpy, 'browse:resource-requested')).toBe(0);
      sub.unsubscribe();
    });

    it('a value the cache still holds is refreshed though its observer has left', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      await firstDefined(browse.events(RID));
      expect(requests(emitSpy, 'browse:events-requested')).toBe(1);

      eventBus.emit('mark:added', fakeMarkAdded(RID, AID));
      await flush();

      expect(requests(emitSpy, 'browse:events-requested')).toBe(2);
    });

    it('a direct invalidate of a key nothing has asked for still fetches it (B8)', async () => {
      const { browse, emitSpy } = createHarness();
      browse.invalidateResourceEvents(RID);
      await flush();
      expect(requests(emitSpy, 'browse:events-requested')).toBe(1);
    });
  });

  describe('B19 — bus-driven invalidations of one key coalesce', () => {
    // Another principal writing at the baseline emit rate — 100 a second for
    // ten seconds — while this session watches.
    const STORM_EVENTS = 1_000;
    const STORM_SPACING_MS = 10;
    // At most once per window while the storm lasts, and once after it.
    const BOUND = Math.ceil((STORM_EVENTS * STORM_SPACING_MS) / INVALIDATION_WINDOW_MS) + 1;
    const requests = (emitSpy: ReturnType<typeof createHarness>['emitSpy'], channel: string) =>
      emitSpy.mock.calls.filter(([ch]) => ch === channel).length;

    it('a bulk import refetches an observed resource list at most once per window, and after its last event', async () => {
      vi.useFakeTimers();
      try {
        const { browse, eventBus, emitSpy } = createHarness();
        const sub = browse.resources().subscribe(() => {});
        await firstDefined(browse.resources());
        const before = requests(emitSpy, 'browse:resources-requested');
        let beforeLast = before;
        for (let i = 0; i < STORM_EVENTS; i++) {
          if (i === STORM_EVENTS - 1) beforeLast = requests(emitSpy, 'browse:resources-requested');
          eventBus.emit('yield:created', fakeYieldCreated(resourceId(`imported-${i}`)));
          await vi.advanceTimersByTimeAsync(STORM_SPACING_MS);
        }
        await vi.advanceTimersByTimeAsync(INVALIDATION_WINDOW_MS);
        const after = requests(emitSpy, 'browse:resources-requested');
        expect(after - before, `list refetches during a ${STORM_EVENTS}-event import`).toBeLessThanOrEqual(BOUND);
        expect(after, 'a refetch after the last event, so the list shows it').toBeGreaterThan(beforeLast);
        sub.unsubscribe();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a stream of marks on the open resource refetches its annotations at most once per window, and ends showing the last', async () => {
      vi.useFakeTimers();
      try {
        const { browse, eventBus, emitSpy, state } = createHarness();
        let shown: Annotation[] = [];
        const sub = browse.annotations(RID).subscribe((s) => {
          if (isReady(s)) shown = s.value;
        });
        await firstDefined(browse.annotations(RID));
        const before = requests(emitSpy, 'browse:annotations-requested');
        for (let i = 0; i < STORM_EVENTS; i++) {
          state.annotationCount = i + 2; // the server's list grows with each mark
          eventBus.emit('mark:added', fakeMarkAdded(RID, `ann-storm-${i}`));
          await vi.advanceTimersByTimeAsync(STORM_SPACING_MS);
        }
        await vi.advanceTimersByTimeAsync(INVALIDATION_WINDOW_MS);
        expect(requests(emitSpy, 'browse:annotations-requested') - before, `annotation refetches during ${STORM_EVENTS} marks`).toBeLessThanOrEqual(BOUND);
        expect(shown, 'the list ends with every mark').toHaveLength(STORM_EVENTS + 1);
        sub.unsubscribe();
      } finally {
        vi.useRealTimers();
      }
    });

    it('one event refetches at once: an isolated write is seen without waiting for a window', async () => {
      vi.useFakeTimers();
      try {
        const { browse, eventBus, emitSpy } = createHarness();
        const sub = browse.annotations(RID).subscribe(() => {});
        await firstDefined(browse.annotations(RID));
        const before = requests(emitSpy, 'browse:annotations-requested');
        eventBus.emit('mark:added', fakeMarkAdded(RID, 'ann-single'));
        await vi.advanceTimersByTimeAsync(0);
        expect(requests(emitSpy, 'browse:annotations-requested')).toBe(before + 1);
        sub.unsubscribe();
      } finally {
        vi.useRealTimers();
      }
    });

    it('disposal closes every window, dropping what they still owed (B16)', async () => {
      vi.useFakeTimers();
      try {
        const { browse, eventBus, emitSpy } = createHarness();
        const sub = browse.annotations(RID).subscribe(() => {});
        await firstDefined(browse.annotations(RID));
        eventBus.emit('mark:added', fakeMarkAdded(RID, 'ann-a'));
        eventBus.emit('mark:added', fakeMarkAdded(RID, 'ann-b'));
        await vi.advanceTimersByTimeAsync(0);
        const settled = emitSpy.mock.calls.length;
        sub.unsubscribe();
        browse.dispose();
        // An open window is a live timer: left running, it would hold a Node
        // process open and fire into caches that no longer exist.
        expect(vi.getTimerCount(), 'timers left running after disposal').toBe(0);
        await vi.advanceTimersByTimeAsync(INVALIDATION_WINDOW_MS * 2);
        expect(emitSpy.mock.calls.length, 'nothing is requested after disposal').toBe(settled);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('B13b — update-in-place writes through without a fetch', () => {
    it('mark:body-updated writes the annotation into both list and detail caches', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      await firstDefined(browse.annotations(RID));
      await firstDefined(browse.annotation(RID, AID));
      expect(emitSpy).toHaveBeenCalledTimes(2);

      const newBody: components['schemas']['TextualBody'] = {
        type: 'TextualBody',
        value: 'new body',
        purpose: 'commenting',
      };
      const updated: Annotation = {
        ...mockAnnotation(AID, 'res-1'),
        body: [newBody],
      };

      // The enriched annotation the EventStore attaches, typed by EventMap.
      eventBus.emit('mark:body-updated', { ...fakeMarkBodyUpdated(RID, updated), annotation: updated });
      await flush();

      const list = await firstDefined(browse.annotations(RID));
      const detail = await firstDefined(browse.annotation(RID, AID));
      const firstListBody = list![0].body;
      const firstDetailBody = detail!.body;
      expect(Array.isArray(firstListBody) ? firstListBody[0] : firstListBody).toMatchObject({ value: 'new body' });
      expect(Array.isArray(firstDetailBody) ? firstDetailBody[0] : firstDetailBody).toMatchObject({ value: 'new body' });

      // Detail arrived without a refetch: the emit count did not grow for that channel.
      const channels = emitSpy.mock.calls.map(([ch]) => ch);
      const detailFetches = channels.filter((c) => c === 'browse:annotation-requested').length;
      expect(detailFetches).toBe(1); // just the initial observe
    });
  });

  // B16 — disposal is terminal and inert at the namespace level. The
  // make-meaning CI escape (2026-07-05): a B14
  // retry straddled client teardown, busRequest resolved `bus.closed`, and
  // the B15 push errored a handler-less subscriber — an unhandled rejection
  // racing worker teardown. Structural fix (finding b): BrowseNamespace owns
  // its caches (A7-owned), so disposing it completes every per-key
  // observable and detaches its bus handlers; the straddling failure then
  // has no observers to error. No `bus.closed` special-casing (finding a).
  describe('B16 — browse.dispose() completes observers; teardown failures are structural no-ops', () => {
    it('mid-chain dispose: value-less-key subscriber completes, never errors; no post-dispose retry traffic', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // Every fetch would fail — but dispose lands before the first
        // failure reply, so the chain must die quietly instead of retrying.
        const { browse, emitSpy } = createHarness({ rejectNext: 2 });

        const events: string[] = [];
        browse.resource(RID).subscribe({
          next: (s) => { if (s.status !== 'pending') events.push('next'); },
          error: () => events.push('error'),
          complete: () => events.push('complete'),
        });
        expect(emitSpy).toHaveBeenCalledTimes(1); // attempt 1 in flight

        browse.dispose();          // teardown straddles the pending reply
        await flush();
        await flush();             // the -failed reply lands post-dispose

        expect(events).toEqual(['complete']);     // completed at dispose — the escape's subscriber shape is safe
        expect(emitSpy).toHaveBeenCalledTimes(1); // no B14 re-issue after dispose
        expect(warnSpy).not.toHaveBeenCalled();   // no teardown breadcrumb noise
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('bus invalidation events arriving after dispose() trigger no fetches', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      await firstDefined(browse.resource(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);

      browse.dispose();
      // mark:added would invalidate the annotation-list + events caches —
      // with the namespace disposed, its bus subscriptions are detached.
      eventBus.emit('mark:added', fakeMarkAdded(RID, 'ann-9'));
      await flush();

      expect(emitSpy).toHaveBeenCalledTimes(1); // nothing refetched
    });

    it('dispose() is idempotent', async () => {
      const { browse } = createHarness();
      await firstDefined(browse.resource(RID));
      browse.dispose();
      expect(() => browse.dispose()).not.toThrow();
    });
  });

  // The collaborator directory.
  // `agents()` is the third KB-wide singleton (tagSchemas pattern): unscoped,
  // sentinel-keyed, entries passed through UNRESHAPED (`servesJobTypes` is the
  // field the P1 wrapper exists for — a flattening implementation must fail here).
  describe('browse.agents() — collaborator directory', () => {
    it('serves CollaboratorEntry[] unreshaped — servesJobTypes intact, absent stays absent — and caches (one fetch)', async () => {
      const { browse, emitSpy } = createHarness();

      const entries = await firstDefined(browse.agents());
      expect(entries).toEqual(MOCK_COLLABORATORS);

      await firstDefined(browse.agents());
      const agentFetches = emitSpy.mock.calls.filter(([ch]) => ch === 'browse:agents-requested').length;
      expect(agentFetches).toBe(1);
    });

    it('B16: browse.dispose() completes an agents() subscriber — the new cache is in the dispose list', async () => {
      const { browse } = createHarness();
      const events: string[] = [];
      browse.agents().subscribe({
        next: (s) => { if (s.status !== 'pending') events.push('next'); },
        error: () => events.push('error'),
        complete: () => events.push('complete'),
      });
      await flush();

      browse.dispose();

      // The directory, then the directory with the limits joined: each
      // arrival is a value. Disposal completes the subscriber either way.
      expect(events.at(-1)).toBe('complete');
      expect(events).not.toContain('error');
      expect(events.filter((e) => e === 'next').length).toBeGreaterThan(0);
    });

    it('a stream that reopens refetches the roster alongside the other KB-wide singletons', async () => {
      const state$ = new BehaviorSubject<ConnectionState>('open');
      const { browse, emitSpy } = createHarness({ state$ });
      await firstDefined(browse.agents());

      // The roster's one real staleness event — a gateway restart with a
      // changed TOML — presents as a dropped stream.
      reopen(state$);
      await flush();

      const agentFetches = emitSpy.mock.calls.filter(([ch]) => ch === 'browse:agents-requested').length;
      expect(agentFetches).toBe(2);
    });

    it('joins each key holder\'s limits onto the entries for its model', async () => {
      const { browse } = createHarness();

      const entries = await firstValueFrom(browse.agents().pipe(
        filter(isReady),
        map((s) => s.value),
        filter((es) => es.every((e) => e.limits !== undefined)),
      ));

      expect(entries.map((e) => [e.agent.model, e.limits])).toEqual([
        ['claude-haiku-4-5', HAIKU_LIMITS],
        ['claude-sonnet-4-5', SONNET_LIMITS],
      ]);
      // The entry is otherwise the directory's, unreshaped.
      expect(entries[0]!.servesJobTypes).toEqual(['reference-annotation', 'generation']);
    });

    it('a silent key holder does not hold the directory, and leaves only its models without limits', async () => {
      const { browse } = createHarness({ silentChannels: ['job:limits-requested'], busTimeoutMs: 60_000 });

      const first = await firstDefined(browse.agents());
      expect(first.map((e) => e.agent.model)).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-5']);

      await flush();
      const entries = await firstDefined(browse.agents());
      expect(entries.find((e) => e.agent.model === 'claude-sonnet-4-5')?.limits).toEqual(SONNET_LIMITS);
      expect(entries.find((e) => e.agent.model === 'claude-haiku-4-5')).not.toHaveProperty('limits');
    });

    it('a stream that reopens asks the key holders again', async () => {
      const state$ = new BehaviorSubject<ConnectionState>('open');
      const { browse, emitSpy } = createHarness({ state$ });
      await firstDefined(browse.agents());
      await flush();

      reopen(state$);
      await flush();

      for (const op of ['job:limits-requested', 'gather:limits-requested', 'match:limits-requested']) {
        expect(emitSpy.mock.calls.filter(([ch]) => ch === op).length, op).toBe(2);
      }
    });

    it('threads busTimeoutMs: an unanswered roster request rejects bus.timeout at the configured deadline', async () => {
      // Silence the B14 breadcrumbs this deliberately-failing chain emits.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { browse } = createHarness({
          silentChannels: ['browse:agents-requested'],
          busTimeoutMs: 60,
        });
        await expect(browse.agents().fresh()).rejects.toMatchObject({ code: 'bus.timeout' });
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
