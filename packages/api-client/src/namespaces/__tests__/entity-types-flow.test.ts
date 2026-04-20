/**
 * Triangulation tests for the entity-types data flow.
 *
 * Written after an e2e failure where `ReferencesPanel` received
 * `allEntityTypes: []` even though the client provably received the
 * full 9-string array from the backend (verified by console-arg
 * capture in Playwright traces).
 *
 * These tests articulate the "how the 9 strings should travel" theory
 * at each composition boundary so that a regression points to the
 * specific seam, not the whole integration stack.
 *
 * Layer-2 tests (this file): BrowseNamespace composes Cache + bus.
 * The seam test here is "entityTypes() survives arbitrary downstream
 * bus events a user session might generate". A failure would confirm
 * Theory C (some handler overwrites the value).
 */

import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, Subject, filter, firstValueFrom, map } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type {
  components,
  EventMap,
  EventMetadata,
  EventOfType,
  ResourceId,
  StoredEvent,
  UserId,
} from '@semiont/core';
import { BrowseNamespace } from '../browse';
import type { SemiontApiClient } from '../../client';
import type { ActorVM, BusEvent, ConnectionState } from '../../view-models/domain/actor-vm';

type Annotation = components['schemas']['Annotation'];

const TEST_USER = 'did:web:test:users:test' as UserId;
const TEST_META = { sequenceNumber: 1, streamPosition: 0 } as EventMetadata;

const NINE_TYPES = [
  'Author', 'Concept', 'Date', 'Event', 'Location',
  'Organization', 'Person', 'Product', 'Technology',
];

function mockAnnotation(id: string, source = 'res-1'): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id,
    motivation: 'commenting',
    created: '2026-01-01T00:00:00Z',
    target: { source },
    body: [],
  };
}

function fakeMarkAdded(rId: ResourceId, annId: string): StoredEvent<EventOfType<'mark:added'>> {
  return {
    id: `evt-${annId}`,
    type: 'mark:added',
    resourceId: rId,
    userId: TEST_USER,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload: { annotation: mockAnnotation(annId) },
    metadata: TEST_META,
  };
}

function fakeMarkRemoved(rId: ResourceId, annId: string): StoredEvent<EventOfType<'mark:removed'>> {
  return {
    id: `evt-${annId}-removed`,
    type: 'mark:removed',
    resourceId: rId,
    userId: TEST_USER,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload: { annotationId: annId },
    metadata: TEST_META,
  };
}

function fakeYieldCreated(rId: string): EventMap['yield:create-ok'] {
  return {
    resourceId: rId,
    resource: { '@context': 'http://schema.org', '@id': rId, name: 'Res', representations: [] },
  } as unknown as EventMap['yield:create-ok'];
}

function fakeMarkArchived(rId: ResourceId): StoredEvent<EventOfType<'mark:archived'>> {
  return {
    id: `evt-archive`,
    type: 'mark:archived',
    resourceId: rId,
    userId: TEST_USER,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload: {},
    metadata: TEST_META,
  };
}

function fakeMarkUnarchived(rId: ResourceId): StoredEvent<EventOfType<'mark:unarchived'>> {
  return {
    id: `evt-unarchive`,
    type: 'mark:unarchived',
    resourceId: rId,
    userId: TEST_USER,
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    payload: {},
    metadata: TEST_META,
  };
}

interface Harness {
  browse: BrowseNamespace;
  eventBus: EventBus;
  actorEvents$: Subject<BusEvent>;
  emit: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
  const events$ = new Subject<BusEvent>();

  const emit = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
    const correlationId = payload.correlationId as string;
    // Respond to exactly the channels the tests exercise.
    let resultChannel: string;
    let response: Record<string, unknown>;
    switch (channel) {
      case 'browse:entity-types-requested':
        resultChannel = 'browse:entity-types-result';
        response = { entityTypes: NINE_TYPES };
        break;
      case 'browse:annotations-requested':
        resultChannel = 'browse:annotations-result';
        response = { annotations: [], total: 0 };
        break;
      case 'browse:events-requested':
        resultChannel = 'browse:events-result';
        response = { events: [], total: 0, resourceId: 'res-1' };
        break;
      default:
        return;
    }
    queueMicrotask(() => {
      events$.next({ channel: resultChannel, payload: { correlationId, response } });
    });
  });

  const actor = {
    on$<T>(channel: string) {
      return events$.pipe(filter((e) => e.channel === channel), map((e) => e.payload as T));
    },
    emit,
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
    addChannels: vi.fn(),
    removeChannels: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  } as ActorVM;

  const http = {} as unknown as SemiontApiClient;
  const eventBus = new EventBus();
  const browse = new BrowseNamespace(http, eventBus, () => undefined, actor);

  return { browse, eventBus, actorEvents$: events$, emit };
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function firstDefined<T>(obs: import('rxjs').Observable<T | undefined>): Promise<T> {
  return firstValueFrom(obs.pipe(filter((v): v is T => v !== undefined)));
}

describe('entity types — Layer 2 (BrowseNamespace + Cache)', () => {
  const RID = makeResourceId('res-1');

  it('entityTypes() emits the 9-string array after a successful fetch', async () => {
    const { browse } = createHarness();
    const val = await firstDefined(browse.entityTypes());
    expect(val).toEqual(NINE_TYPES);
  });

  it('a second (late) subscriber to entityTypes() ALSO sees the 9 strings', async () => {
    const { browse } = createHarness();
    // First subscriber populates the cache.
    await firstDefined(browse.entityTypes());
    // Now a fresh subscribe — must see the cached value, not undefined.
    const val = await firstDefined(browse.entityTypes());
    expect(val).toEqual(NINE_TYPES);
  });

  it('entityTypes() survives a burst of unrelated bus events', async () => {
    // This is the test that would fail if Theory C (overwrite) is real.
    // We populate the cache, then fire every downstream event a real
    // session might emit, and assert the value is still there.
    const { browse, eventBus } = createHarness();

    await firstDefined(browse.entityTypes());

    // A realistic session emits these after opening a resource and
    // creating a highlight. None of them should affect entity types.
    eventBus.get('mark:added').next(fakeMarkAdded(RID, 'ann-1'));
    eventBus.get('mark:removed').next(fakeMarkRemoved(RID, 'ann-1'));
    eventBus.get('yield:create-ok').next(fakeYieldCreated('res-1'));
    eventBus.get('yield:update-ok').next(fakeYieldCreated('res-1'));
    eventBus.get('mark:archived').next(fakeMarkArchived(RID));
    eventBus.get('mark:unarchived').next(fakeMarkUnarchived(RID));

    await flush();
    await flush();

    const val = await firstValueFrom(browse.entityTypes());
    expect(val).toEqual(NINE_TYPES);
  });

  it('entityTypes() emits SYNCHRONOUSLY to a subscriber after the cache is populated', async () => {
    // Theory B says a subscriber arriving after a write sees the value
    // on the very first emission (BehaviorSubject-like semantics from
    // the Cache primitive). Tests this contract directly.
    const { browse } = createHarness();
    await firstDefined(browse.entityTypes());

    let first: string[] | undefined;
    const sub = browse.entityTypes().subscribe((v) => {
      if (first === undefined) first = v;
    });
    try {
      expect(first).toEqual(NINE_TYPES);
    } finally {
      sub.unsubscribe();
    }
  });

  it('entityTypes() invalidation keeps the value visible during SWR refetch', async () => {
    // If something (mark:entity-type-added, bus:resume-gap) calls
    // invalidateEntityTypes(), the observable must NOT emit undefined
    // during the refetch window.
    const { browse } = createHarness();
    await firstDefined(browse.entityTypes());

    const emissions: Array<string[] | undefined> = [];
    const sub = browse.entityTypes().subscribe((v) => emissions.push(v));
    try {
      browse.invalidateEntityTypes();
      await flush();
      await flush();

      // Every emission must be the full array — no undefined/empty blips.
      for (const e of emissions) {
        expect(e).toEqual(NINE_TYPES);
      }
    } finally {
      sub.unsubscribe();
    }
  });
});

/**
 * Layer-3 test: real BrowseNamespace + real VM pipe.
 *
 * The existing resource-viewer-page-vm tests stub `client.browse` with
 * a BehaviorSubject, so they never exercise the Cache → VM pipe under
 * realistic bus conditions. This test uses the real BrowseNamespace
 * with a mock actor — closer to production wiring.
 */
describe('entity types — Layer 3 (VM pipe over real cache)', () => {
  const RID = makeResourceId('res-1');

  it('vm.entityTypes$ emits [9 strings] via the real cache', async () => {
    const { browse, actorEvents$: _events, emit: _emit } = createHarness();

    // Mimic the VM's transform: `client.browse.entityTypes().pipe(map(e => e ?? []))`
    const vmEntityTypes$ = browse.entityTypes().pipe(map((e) => e ?? []));

    const val = await firstValueFrom(vmEntityTypes$.pipe(filter((v) => v.length > 0)));
    expect(val).toEqual(NINE_TYPES);
  });

  it('vm.entityTypes$ is stable across BrowseNamespace re-subscribe (B4)', async () => {
    const { browse } = createHarness();
    const obs1 = browse.entityTypes();
    const obs2 = browse.entityTypes();
    // Per CACHE-SEMANTICS B4: same key, same observable.
    expect(obs1).toBe(obs2);

    await firstDefined(obs1);
    // Late re-check — still the same reference.
    expect(browse.entityTypes()).toBe(obs1);
  });

  // The real-world failure mode: the VM is created AFTER the cache has
  // already been populated (e.g. another mounted component subscribed
  // first). The VM's late pipe must still see the populated value.
  it('VM pipe subscribing AFTER cache is populated still emits [9 strings]', async () => {
    const { browse } = createHarness();
    // Populate the cache via an unrelated subscriber.
    await firstDefined(browse.entityTypes());

    // Now compose a new VM pipe — simulates a later ResourceViewerPage mount.
    const lateVmPipe$ = browse.entityTypes().pipe(map((e) => e ?? []));
    const val = await firstValueFrom(lateVmPipe$);
    expect(val).toEqual(NINE_TYPES);
  });

  it(
    'VM pipe subscribing AFTER cache is populated AND after a bus-event burst still emits [9 strings]',
    async () => {
      // This is the most production-like scenario: cache warmed, bus
      // churn, THEN a new component mounts and reads entityTypes.
      const { browse, eventBus } = createHarness();

      await firstDefined(browse.entityTypes());
      eventBus.get('mark:added').next(fakeMarkAdded(RID, 'ann-1'));
      eventBus.get('yield:create-ok').next(fakeYieldCreated('res-1'));
      eventBus.get('mark:archived').next(fakeMarkArchived(RID));
      await flush();

      const lateVmPipe$ = browse.entityTypes().pipe(map((e) => e ?? []));
      const val = await firstValueFrom(lateVmPipe$);
      expect(val).toEqual(NINE_TYPES);
    },
  );
});
