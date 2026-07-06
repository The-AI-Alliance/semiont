/**
 * Cache-semantics contract tests.
 *
 * Enumerates behaviors B1–B16 from
 * `packages/sdk/docs/CACHE-SEMANTICS.md` against `BrowseNamespace`.
 *
 * Each `describe` block is tagged with the behavior number it verifies.
 * Adding a behavior to the spec must add a test here; changing one must
 * update both.
 */

import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom, filter, BehaviorSubject } from 'rxjs';
import { EventBus, resourceId, annotationId } from '@semiont/core';
import type { components, StoredEvent, EventOfType, EventMetadata, UserId, ResourceId, EventMap } from '@semiont/core';
import type { ConnectionState } from '@semiont/core';
import { BrowseNamespace } from '../browse';
import type { ITransport, IContentTransport } from '@semiont/core';

import type { Annotation } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';

const TEST_USER_ID = 'did:web:test:users:test' as UserId;
const TEST_METADATA = { sequenceNumber: 1 } as EventMetadata;

function mockAnnotation(id: string, source = 'res-1'): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(id),
    motivation: 'commenting',
    created: '2026-01-01T00:00:00Z',
    target: { source },
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
): StoredEvent<EventOfType<'mark:body-updated'>> {
  return {
    id: `evt-${updated.id}-body-updated`,
    type: 'mark:body-updated',
    resourceId: rId,
    userId: TEST_USER_ID,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    // The on-the-wire AnnotationBodyUpdatedPayload describes ops, not
    // the final annotation. The enriched-event shape (what handlers
    // actually receive after ViewMaterializer runs) carries the full
    // annotation as a top-level `annotation` field; the test augments
    // this StoredEvent with that field after construction.
    payload: { annotationId: updated.id, operations: [] },
    metadata: TEST_METADATA,
  };
}

function fakeBusResumeGap(scope: string | undefined, reason: string): EventMap['bus:resume-gap'] {
  return scope === undefined ? { reason } : { scope, reason };
}

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
}

function createHarness(opts: HarnessOptions = {}) {
  const transportBus = new EventBus();
  const state = {
    resourceName: opts.resourceName ?? ((id: string) => `Resource ${id}`),
    rejectRemaining: opts.rejectNext ?? 0,
    annotationCount: opts.annotationCountAfterReset ?? 1,
  };

  const emitSpy = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
    const correlationId = payload.correlationId as string;

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
        response = { resources: [mockResource('res-1')], total: 1, offset: 0, limit: 20 };
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
      default:
        return;
    }

    if (state.rejectRemaining > 0) {
      state.rejectRemaining--;
      queueMicrotask(() => {
        (transportBus.get(resultChannel.replace('-result', '-failed') as never) as { next(v: unknown): void })
          .next({ correlationId, error: { message: 'rejected by test' } });
      });
    } else {
      queueMicrotask(() => {
        (transportBus.get(resultChannel as never) as { next(v: unknown): void }).next({ correlationId, response });
      });
    }
  });

  const transport = {
    emit: emitSpy,
    on: <K extends never>(channel: K, handler: (p: never) => void) => {
      const sub = (transportBus.get(channel) as { subscribe(fn: (p: never) => void): { unsubscribe(): void } }).subscribe(handler);
      return () => sub.unsubscribe();
    },
    stream: <K extends never>(channel: K) => transportBus.get(channel),
    subscribeToResource: vi.fn().mockReturnValue(() => {}),
    bridgeInto: vi.fn(),
    state$: (opts.state$ ?? new BehaviorSubject<ConnectionState>('open')).asObservable() as never,
    dispose: vi.fn(),
  } as unknown as ITransport;

  const content: IContentTransport = {
    putBinary: vi.fn(),
    getBinary: vi.fn(),
    getBinaryStream: vi.fn(),
    getResourceGraph: vi.fn(),
    dispose: vi.fn(),
  };

  const eventBus = new EventBus();
  const browse = new BrowseNamespace(transport, eventBus, content);

  return { browse, eventBus, emitSpy, state };
}

function firstDefined<T>(obs: import('rxjs').Observable<T | undefined>): Promise<T> {
  return firstValueFrom(obs.pipe(filter((v): v is T => v !== undefined)));
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
      browse.resource(RID).subscribe((v) => seen.push(v));
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
      // key's observers — not `undefined` forever (LIVENESS-AXIOMS L1; see
      // .plans/bugs/valueless-key-terminal-failure-starves-observers.md).
      const { browse, emitSpy, state } = createHarness({ rejectNext: 2 });
      const seen: Array<ResourceDescriptor | undefined> = [];
      const errors: unknown[] = [];
      browse.resource(RID).subscribe({ next: (v) => seen.push(v), error: (e) => errors.push(e) });
      await flush();
      expect(seen).toEqual([undefined]);
      expect(errors).toHaveLength(1); // surfaced through withScope + CacheObservable
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
      browse.resource(RID).subscribe((v) => seen.push(v));
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
      // Value-less exhaustion also errors this subscriber (B15) — absorbed;
      // this test is about the in-flight guard, not the notification.
      browse.resource(RID).subscribe({ next: (v) => seen.push(v), error: () => {} });
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
      const { browse, eventBus, emitSpy } = createHarness();
      await firstDefined(browse.annotations(RID));
      expect(emitSpy).toHaveBeenCalledTimes(1);

      eventBus.get('mark:added').next(fakeMarkAdded(RID, AID));
      await flush();
      expect(emitSpy).toHaveBeenCalledTimes(3); // annotations + events refetched

      eventBus.get('mark:removed').next(fakeMarkRemoved(RID, AID));
      await flush();
      // Each is independent; mark:removed also fires annotations + events refetch.
      expect(emitSpy).toHaveBeenCalledTimes(5);
    });
  });

  describe('B13 — reconnect gap-detection (post-BUS-RESUMPTION)', () => {
    it('a bare state machine reconnect cycle does NOT refetch — resumption handles it', async () => {
      const state$ = new BehaviorSubject<ConnectionState>('open');
      const { browse, emitSpy } = createHarness({ state$ });

      await firstDefined(browse.resource(RID));
      await firstDefined(browse.annotations(RID));
      expect(emitSpy).toHaveBeenCalledTimes(2);

      // Simulate a full reconnect lifecycle: open → reconnecting →
      // connecting → open. Nothing here asks for invalidation —
      // resumption is assumed to have covered any gap.
      state$.next('reconnecting');
      state$.next('connecting');
      state$.next('open');
      await flush();

      // No new fetches — the client assumes resumption covered the gap.
      // Old contract (pre-BUS-RESUMPTION) would have refetched everything.
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it('`bus:resume-gap` with a scope invalidates only keys for that scope', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      const RID_A = resourceId('res-A');
      const RID_B = resourceId('res-B');
      await firstDefined(browse.resource(RID_A));
      await firstDefined(browse.annotations(RID_A));
      await firstDefined(browse.resource(RID_B));
      expect(emitSpy).toHaveBeenCalledTimes(3);

      eventBus.get('bus:resume-gap').next(fakeBusResumeGap(RID_A, 'retention-exceeded'));
      await flush();

      // Keys in scope A refetched; key in scope B untouched (aside from
      // the entity-types refetch that always fires on any gap).
      const channels = emitSpy.mock.calls.map(([ch]) => ch);
      // Count post-gap resource fetches by scope.
      const postGap = channels.slice(3);
      expect(postGap.filter((c) => c === 'browse:resource-requested').length).toBe(1);
      expect(postGap.filter((c) => c === 'browse:annotations-requested').length).toBe(1);
      expect(postGap.filter((c) => c === 'browse:entity-types-requested').length).toBe(1);
    });

    it('`bus:resume-gap` without a scope invalidates every live key (fallback)', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      await firstDefined(browse.resource(RID));
      await firstDefined(browse.annotations(RID));
      expect(emitSpy).toHaveBeenCalledTimes(2);

      eventBus.get('bus:resume-gap').next(fakeBusResumeGap(undefined, 'unparseable-last-event-id'));
      await flush();

      const channels = emitSpy.mock.calls.map(([ch]) => ch);
      const refetchCount = channels.filter((c) =>
        c === 'browse:resource-requested' || c === 'browse:annotations-requested',
      ).length;
      expect(refetchCount).toBeGreaterThanOrEqual(4);
    });
  });

  describe('B13a — remove vs invalidate', () => {
    it('removeAnnotationDetail drops the entry and does not refetch (no cached observer)', async () => {
      const { browse, eventBus, emitSpy } = createHarness();
      // Seed the detail cache via initial observation.
      await firstDefined(browse.annotation(RID, AID));
      expect(emitSpy).toHaveBeenCalledTimes(1);

      // mark:delete-ok → remove path.
      const deleteOkPayload: components['schemas']['MarkDeleteOk'] = { response: { annotationId: AID } };
      eventBus.get('mark:delete-ok').next(deleteOkPayload);
      await flush();

      // Nothing else was fetched after the remove: no refetch side effect.
      expect(emitSpy).toHaveBeenCalledTimes(1);
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

      // browse.ts's `mark:body-updated` handler reads `.annotation` via an
      // EnrichedResourceEvent cast that's off the main StoredEvent type.
      // We construct a StoredEvent (type-valid for Subject.next) and
      // augment it with the enriched-annotation field the handler expects.
      const storedBody = fakeMarkBodyUpdated(RID, updated);
      (storedBody as unknown as { annotation: Annotation }).annotation = updated;
      eventBus.get('mark:body-updated').next(storedBody);
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
  // make-meaning CI escape (.plans/LIVENESS-AXIOMS.md, 2026-07-05): a B14
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
          next: (v) => { if (v !== undefined) events.push('next'); },
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
      eventBus.get('mark:added').next(fakeMarkAdded(RID, 'ann-9'));
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
});
