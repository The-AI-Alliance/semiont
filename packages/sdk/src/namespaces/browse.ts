import { Observable, combineLatest, map } from 'rxjs';
import { CacheObservable } from '../awaitable';
import { searchQuery, decodeWithCharset } from '@semiont/core';
import type { AnchoredTextAnswer } from '@semiont/core';
import type {
  Annotation,
  EventBus,
  EventMap,
  ResourceDescriptor,
  ResourceId,
  AnchorRect,
  AnnotationId,
  TagSchema,
  Collaborator,
  CollaboratorEntry,
  KbDescription,
  LimitsOperation,
  components,
} from '@semiont/core';
import type { ITransport, IContentTransport } from '@semiont/core';
import { busRequest, BusRequestError, CACHE_REFRESH, INVALIDATION_WINDOW_MS, LIMITS_OPERATIONS } from '@semiont/core';
import type { CacheQuery, CacheRefresh, CacheRefreshTrigger, CacheRefreshWhen } from '@semiont/core';
import { createCache, type CacheState, type Cache, type CachePersister } from '../cache';
import { sessionStoragePersister } from '../cache-persister';
import type { SessionStorage } from '../session/session-storage';

/**
 * B17 — serialized-shape version shared by every persisted browse cache.
 * Bump when any persisted value shape changes; stale documents then read
 * as empty and refetch.
 */
const CACHE_PERSISTENCE_VERSION = 1;
import type {
  BrowseNamespace as IBrowseNamespace,
  ReferencedByEntry,
  AnnotationHistoryResponse,
  ResourceList,
} from './types';
type StoredEventResponse = components['schemas']['StoredEventResponse'];
type GetResourceResponse = components['schemas']['GetResourceResponse'];
type AnnotationsListResponse = components['schemas']['GetAnnotationsResponse'];

type ResourceListFilters = {
  limit?: number;
  archived?: boolean;
  search?: string;
  entityType?: string;
};

/**
 * B19 — per key, the first invalidation runs at once and opens a window; any
 * more inside it are owed, and run as one when it closes, which opens the next.
 */
class InvalidationWindows {
  private readonly open = new Map<string, { owed: (() => void) | null; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly windowMs: number) {}

  run(key: string, invalidate: () => void): void {
    const window = this.open.get(key);
    if (window) {
      window.owed = invalidate;
      return;
    }
    invalidate();
    const timer = setTimeout(() => {
      const owed = this.open.get(key)?.owed;
      this.open.delete(key);
      if (owed) this.run(key, owed);
    }, this.windowMs);
    this.open.set(key, { owed: null, timer });
  }

  /** B16: an owed invalidation dies with the namespace. */
  dispose(): void {
    for (const { timer } of this.open.values()) clearTimeout(timer);
    this.open.clear();
  }
}

/** Sentinel key for the singleton entity-types cache. */
const ENTITY_TYPES_KEY = '_';

/** Sentinel key for the singleton tag-schemas cache. */
const TAG_SCHEMAS_KEY = '_';

/** Sentinel key for the singleton collaborator-directory cache. */
const AGENTS_KEY = '_';

type InferencePairLimits = components['schemas']['InferencePairLimits'];

/** What a trigger names: which of a split channel's rows it is, the keys a `subject` reach acts on, and the value an enriched event carries. */
interface RefreshSubject {
  when?: CacheRefreshWhen;
  resource?: ResourceId;
  annotation?: AnnotationId;
  written?: Annotation;
}

/** The channels specs/src/client/refresh.json has a row for. */
type RefreshChannel = Exclude<CacheRefreshTrigger, 'reopened'>;

/**
 * What each channel's event names. What follows from it is the table's to
 * say (`CACHE_REFRESH`), so a row added there with no entry here does not
 * compile.
 */
const SUBJECT_OF: { [K in RefreshChannel]: (event: EventMap[K]) => RefreshSubject } = {
  'bus:resume-gap': (gap) => ({ resource: gap.scope }),
  'mark:added': (stored) => ({ resource: stored.resourceId }),
  'mark:removed': (stored) => ({ resource: stored.resourceId, annotation: stored.payload.annotationId }),
  'mark:delete-ok': (reply) => ({ annotation: reply.response.annotationId }),
  'mark:body-updated': (stored) =>
    stored.annotation
      ? { when: 'enriched', resource: stored.resourceId, annotation: stored.annotation.id, written: stored.annotation }
      : { when: 'unenriched', resource: stored.resourceId, annotation: stored.payload.annotationId },
  'mark:entity-tag-added': (stored) => ({ resource: stored.resourceId }),
  'mark:entity-tag-removed': (stored) => ({ resource: stored.resourceId }),
  'mark:archived': (stored) => ({ resource: stored.resourceId }),
  'mark:unarchived': (stored) => ({ resource: stored.resourceId }),
  // Cross-client resource refresh rides the persisted domain events, never
  // the request replies: a `yield:*-ok` reply reaches only the client that
  // asked, and would leave every other viewer's list stale.
  'yield:created': (stored) => ({ resource: stored.resourceId }),
  'yield:updated': (stored) => ({ resource: stored.resourceId }),
  'yield:cloned': (stored) => ({ resource: stored.resourceId }),
  'yield:moved': (stored) => ({ resource: stored.resourceId }),
  'frame:entity-type-added': () => ({}),
  'frame:tag-schema-added': () => ({}),
};

/** The directory with each reported model's limits on its entries. */
function joinLimits(directory: CollaboratorEntry[], reported: InferencePairLimits[]): Collaborator[] {
  return directory.map((entry) => {
    const agent = entry.agent;
    if (agent['@type'] !== 'Software') return entry;
    const pair = reported.find((r) => r.provider === agent.provider && r.model === agent.model);
    return pair ? { ...entry, limits: pair.limits } : entry;
  });
}

export class BrowseNamespace implements IBrowseNamespace {
  // ── Caches, backed by the RxJS-native `Cache<K, V>` primitive ───────────
  //
  // Each cache encapsulates the BehaviorSubject store, in-flight guard,
  // and per-key observable memoization that was previously open-coded
  // here. Behavioral contract: `packages/sdk/docs/CACHE-SEMANTICS.md`.
  //
  // Public surface (`resource()`, `annotations()`, etc.) is unchanged;
  // the caches are an implementation detail of this namespace.

  private readonly resourceCache: Cache<ResourceId, ResourceDescriptor>;
  private readonly resourceListCache: Cache<string, ResourceList>;
  private readonly annotationListCache: Cache<ResourceId, AnnotationsListResponse>;
  /**
   * Annotation-detail cache keyed by `annotationId` only — the resourceId
   * is a routing hint for the gateway fetch, not an identity component.
   * We track the most recent resourceId per annotationId in a side-map
   * so `mark:delete-ok` (which carries only `annotationId`) can reach
   * the right cache entry. Aligns with the pre-refactor semantics.
   */
  private readonly annotationDetailCache: Cache<AnnotationId, Annotation>;
  private readonly annotationResources = new Map<AnnotationId, ResourceId>();
  private readonly entityTypesCache: Cache<string, string[]>;
  private readonly tagSchemasCache: Cache<string, TagSchema[]>;
  private readonly agentsCache: Cache<string, CollaboratorEntry[]>;
  /** Each key holder's limits report, by the operation it answers. */
  private readonly limitsCache: Cache<LimitsOperation, InferencePairLimits[]>;
  /** The directory, joined with the limits reports as each arrives. */
  private readonly collaborators$: Observable<CacheState<Collaborator[]>>;
  private readonly referencedByCache: Cache<ResourceId, ReferencedByEntry[]>;
  private readonly resourceEventsCache: Cache<ResourceId, StoredEventResponse[]>;

  /** Filter-blob memory so `invalidateResourceLists` can replay per-key. */
  private readonly resourceListFilters = new Map<string, ResourceListFilters>();

  /**
   * Per-key memo for `annotations()` observables. The cache stores the
   * full `AnnotationsListResponse`; the public shape is just the inner
   * `Annotation[]`. Without this memo, every call to `annotations(rId)`
   * would produce a fresh `.pipe(map(...))` observable, violating B4
   * (per-key observable stability). Consumers that compare observable
   * identity — React hooks depending on the observable reference,
   * `distinctUntilChanged` at a higher level — would misbehave.
   */
  private readonly annotationListObs = new Map<ResourceId, Observable<CacheState<Annotation[]>>>();

  /**
   * Per-source memo for the scope-acquiring wrapper (#847 Phase 4), keyed by
   * the underlying (stable, per-key) cache observable so the wrapped
   * observable is itself stable per key — preserving B4/B11 referential
   * identity through to `CacheObservable.from`'s own memo.
   */
  private readonly scopedSources = new WeakMap<Observable<unknown>, Observable<unknown>>();

  /**
   * Timeout passed to every `busRequest` this namespace issues. `undefined`
   * means `busRequest`'s default (30 s). Injectable so the liveness
   * properties (`.plans/LIVENESS-AXIOMS.md`) can run the real composition on
   * deterministic virtual time — the same knob `HttpTransportConfig.timeout`
   * provides at the HTTP layer.
   */
  private readonly busTimeoutMs: number | undefined;

  /**
   * The `subscribeToEvents()` bus subscriptions, held so `dispose()` can
   * detach them — a disposed namespace must not react to late bus events
   * by refetching into disposed caches (B16).
   */
  private readonly busSubs: Array<{ unsubscribe(): void }> = [];

  private readonly invalidationWindows: InvalidationWindows;

  /**
   * Ask again for one key, as a row of the refresh table says to. Only a key
   * the cache knows (B20): an event about a key nothing has asked for has
   * nothing to refresh, and refreshing it anyway cost every viewer a request
   * per resource another principal imported. Each goes through its key's
   * window (B19). The public `invalidate*` methods stay immediate, and fetch
   * whatever the key holds (B8), for direct callers.
   */
  private readonly refetchKey = {
    resource: (rId: ResourceId) => this.held(this.resourceCache, rId, `resource/${rId}`, () => this.invalidateResourceDetail(rId)),
    annotations: (rId: ResourceId) => this.held(this.annotationListCache, rId, `annotations/${rId}`, () => this.invalidateAnnotationList(rId)),
    annotation: (aId: AnnotationId) => this.held(this.annotationDetailCache, aId, `annotation/${aId}`, () => this.annotationDetailCache.invalidate(aId)),
    events: (rId: ResourceId) => this.held(this.resourceEventsCache, rId, `events/${rId}`, () => this.invalidateResourceEvents(rId)),
    referencedBy: (rId: ResourceId) => this.held(this.referencedByCache, rId, `referenced-by/${rId}`, () => this.invalidateReferencedBy(rId)),
  };

  private held<K>(cache: { known(key: K): boolean }, key: K, window: string, invalidate: () => void): void {
    if (cache.known(key)) this.invalidationWindows.run(window, invalidate);
  }

  /**
   * B17-Q — the persisted caches, registered at construction, for the
   * quiescence check gating the resumption-bookmark flush. Empty when
   * persistence is off (settled is then vacuously true).
   */
  private readonly persistedCaches: Array<{ persistencePending(): boolean }> = [];

  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
    private readonly content: IContentTransport,
    options?: {
      busTimeoutMs?: number;
      /**
       * B19's window, `invalidationWindowMs` of specs/src/client/timing.json,
       * for a caller that must not wait it out: a test, or the conformance
       * driver. Absent, the table's value stands.
       */
      invalidationWindowMs?: number;
      /**
       * B17 — opt into cache persistence through the environment's
       * SessionStorage adapter. keyPrefix is the KB id (cache data is
       * KB-specific). Omitted = in-memory-only, today's behavior.
       */
      cachePersistence?: { storage: SessionStorage; keyPrefix: string };
    },
  ) {
    this.busTimeoutMs = options?.busTimeoutMs;
    this.invalidationWindows = new InvalidationWindows(options?.invalidationWindowMs ?? INVALIDATION_WINDOW_MS);

    // The opt-in table (see .plans/LOCAL-STORAGE.md): small, first-paint
    // caches persist; lists, event histories, and the collaborator
    // directory stay in-memory.
    const persistence = options?.cachePersistence;
    const persisted = <K, V>(name: string): { persister: CachePersister<K, V> } | undefined =>
      persistence
        ? {
            persister: sessionStoragePersister<K, V>({
              storage: persistence.storage,
              storageKey: `semiont.cache.${persistence.keyPrefix}.${name}`,
              version: CACHE_PERSISTENCE_VERSION,
            }),
          }
        : undefined;
    // B17-Q: every persisted cache registers for the quiescence check that
    // gates the resumption-bookmark flush (`persistenceSettled`).
    const track = <C extends { persistencePending(): boolean }>(cache: C): C => {
      if (persistence) this.persistedCaches.push(cache);
      return cache;
    };

    this.resourceCache = track(createCache<ResourceId, ResourceDescriptor>(async (id) => {
      const result = await busRequest(
        this.transport,
        'browse:resource-requested',
        { resourceId: id },
        this.busTimeoutMs,
      );
      return result.resource as ResourceDescriptor;
    }, persisted<ResourceId, ResourceDescriptor>('resource')));

    this.resourceListCache = createCache<string, ResourceList>(async (key) => {
      const filters = this.resourceListFilters.get(key) ?? {};
      const search = filters.search ? searchQuery(filters.search) : undefined;
      const result = await busRequest(
        this.transport,
        'browse:resources-requested',
        {
          search,
          archived: filters.archived,
          entityType: filters.entityType,
          limit: filters.limit ?? 100,
          offset: 0,
        },
        this.busTimeoutMs,
      );
      // Brand the wire type (unbranded @id: string) to the SDK's ResourceDescriptor
      // (@id: ResourceId) at the boundary — same as resourceCache above. The
      // whole envelope is cached, not just the page: `matchKind` and the list
      // it labels are one value (SEMANTIC-FALLBACK S10).
      return { ...result, resources: result.resources as ResourceDescriptor[] };
    });

    this.annotationListCache = track(createCache<ResourceId, AnnotationsListResponse>(async (resourceId) => {
      return busRequest(
        this.transport,
        'browse:annotations-requested',
        { resourceId },
        this.busTimeoutMs,
      );
    }, persisted<ResourceId, AnnotationsListResponse>('annotations')));

    this.annotationDetailCache = track(createCache<AnnotationId, Annotation>(async (annotationId) => {
      const resourceId = this.annotationResources.get(annotationId);
      if (!resourceId) {
        throw new Error(`Cannot fetch annotation ${annotationId}: no resourceId known`);
      }
      const result = await busRequest(
        this.transport,
        'browse:annotation-requested',
        { resourceId, annotationId },
        this.busTimeoutMs,
      );
      return result.annotation as Annotation;
    }, persisted<AnnotationId, Annotation>('annotation-detail')));

    this.entityTypesCache = track(createCache<string, string[]>(async () => {
      const result = await busRequest(
        this.transport,
        'browse:entity-types-requested',
        {},
        this.busTimeoutMs,
      );
      return result.entityTypes;
    }, persisted<string, string[]>('entity-types')));

    this.tagSchemasCache = track(createCache<string, TagSchema[]>(async () => {
      const result = await busRequest(
        this.transport,
        'browse:tag-schemas-requested',
        {},
        this.busTimeoutMs,
      );
      return result.tagSchemas;
    }, persisted<string, TagSchema[]>('tag-schemas')));

    this.agentsCache = createCache<string, CollaboratorEntry[]>(async () => {
      const result = await busRequest(
        this.transport,
        'browse:agents-requested',
        {},
        this.busTimeoutMs,
      );
      // Entries pass through unreshaped: `{ agent, servesJobTypes? }` — the
      // capability field is the point of the wrapper (COLLABORATOR-DIRECTORY P1).
      return result.agents;
    });

    // The services holding the inference credentials report their models'
    // limits; nothing else can discover them. One that is down or silent
    // reports nothing, so its models show no limits, and it delays only its
    // own report, never the directory.
    this.limitsCache = createCache<LimitsOperation, InferencePairLimits[]>(async (operation) =>
      busRequest(this.transport, operation, {}, this.busTimeoutMs).then((result) => result.limits, () => []));

    this.collaborators$ = combineLatest([
      this.agentsCache.observe(AGENTS_KEY),
      ...LIMITS_OPERATIONS.map((operation) => this.limitsCache.observe(operation)),
    ]).pipe(map(([directory, ...reports]): CacheState<Collaborator[]> =>
      directory.status === 'ready'
        ? { status: 'ready', value: joinLimits(directory.value, reports.flatMap((r) => (r.status === 'ready' ? r.value : []))) }
        : directory));

    this.referencedByCache = createCache<ResourceId, ReferencedByEntry[]>(async (resourceId) => {
      const result = await busRequest(
        this.transport,
        'browse:referenced-by-requested',
        { resourceId },
        this.busTimeoutMs,
      );
      return result.referencedBy;
    });

    this.resourceEventsCache = createCache<ResourceId, StoredEventResponse[]>(async (resourceId) => {
      const result = await busRequest(
        this.transport,
        'browse:events-requested',
        { resourceId },
        this.busTimeoutMs,
      );
      return result.events;
    });

    this.subscribeToEvents();
  }

  /**
   * Wrap a resource-scoped live query's source so that *subscribing* acquires
   * the resource's scope (via the transport's ref-counted
   * `subscribeToResource`) and the last unsubscribe releases it (#847 Phase 4).
   * Freshness follows observation: a `.subscribe()` keeps `rId`'s scoped
   * events flowing — so `mark:*` / entity-tag invalidations reach this cache —
   * with no separate `subscribeToResource` call from the consumer.
   *
   * The one-shot `.fresh()` path does NOT go through here (it resolves via
   * the cache's `fetch` — see `CacheObservable.from`'s `fetchFresh`), so a
   * one-shot read acquires no scope.
   *
   * Memoized per source so the wrapped observable is stable per key (B4/B11).
   * Each subscription calls `subscribeToResource(rId)`; the transport
   * ref-counts per resource, and DISTINCT resources COMPOSE onto the one SSE
   * connection's subscription matrix (MULTI-RESOURCE-SCOPE) — N mounted
   * loaders on N resources are all fully live. The single-scope contention
   * state (and its `[browse SCOPE-CONTENTION]` degradation,
   * starvation-fix P2.5) no longer exists: acquisition cannot fail.
   */
  private withScope<S>(rId: ResourceId, source: Observable<S>): Observable<S> {
    let scoped = this.scopedSources.get(source) as Observable<S> | undefined;
    if (!scoped) {
      scoped = new Observable<S>((subscriber) => {
        const release = this.transport.subscribeToResource(rId);
        const inner = source.subscribe(subscriber);
        return () => {
          inner.unsubscribe();
          release();
        };
      });
      this.scopedSources.set(source, scoped);
    }
    return scoped;
  }

  // ── Live queries ────────────────────────────────────────────────────────
  //
  // These return `CacheObservable<T>`: subscribers see `CacheState<T>`
  // (`pending` during initial load), and `.fresh()` is the one-shot read.

  resource(resourceId: ResourceId): CacheObservable<ResourceDescriptor> {
    return CacheObservable.from(this.withScope(resourceId, this.resourceCache.observe(resourceId)), () => this.resourceCache.fetch(resourceId));
  }

  resources(filters?: ResourceListFilters): CacheObservable<ResourceList> {
    const key = JSON.stringify(filters ?? {});
    // Remember the filter blob so `invalidateResourceLists` can drive
    // per-key SWR refetches without the caller re-passing filters.
    this.resourceListFilters.set(key, filters ?? {});
    return CacheObservable.from(this.resourceListCache.observe(key), () => this.resourceListCache.fetch(key));
  }

  annotations(resourceId: ResourceId): CacheObservable<Annotation[]> {
    let obs = this.annotationListObs.get(resourceId);
    if (!obs) {
      obs = this.annotationListCache.observe(resourceId).pipe(
        map((s): CacheState<Annotation[]> => (s.status === 'ready' ? { status: 'ready', value: s.value.annotations as Annotation[] } : s)),
      );
      this.annotationListObs.set(resourceId, obs);
    }
    return CacheObservable.from(this.withScope(resourceId, obs), () => this.annotationListCache.fetch(resourceId).then((r) => r.annotations as Annotation[]));
  }

  annotation(resourceId: ResourceId, annotationId: AnnotationId): CacheObservable<Annotation> {
    // Record the routing hint so the cache's fetchFn (which only sees
    // the cache key, `annotationId`) can look up the resourceId it
    // needs for the bus request.
    this.annotationResources.set(annotationId, resourceId);
    return CacheObservable.from(this.withScope(resourceId, this.annotationDetailCache.observe(annotationId)), () => this.annotationDetailCache.fetch(annotationId));
  }

  entityTypes(): CacheObservable<string[]> {
    return CacheObservable.from(this.entityTypesCache.observe(ENTITY_TYPES_KEY), () => this.entityTypesCache.fetch(ENTITY_TYPES_KEY));
  }

  tagSchemas(): CacheObservable<TagSchema[]> {
    return CacheObservable.from(this.tagSchemasCache.observe(TAG_SCHEMAS_KEY), () => this.tagSchemasCache.fetch(TAG_SCHEMAS_KEY));
  }

  /**
   * The KB's collaborator directory: its declared software agents (from the
   * KB's worker/actor config, with `servesJobTypes` capabilities) and — once
   * Persons land — its members. KB-wide singleton, cached for the client's
   * lifetime; no membership-change event exists, so the only refresh triggers
   * are the stream reopening after a drop (a gateway restart with a changed
   * roster presents as one) and a fresh `await` (which always fetches).
   */
  agents(): CacheObservable<Collaborator[]> {
    return CacheObservable.from(this.collaborators$, async () => {
      const [directory, ...reports] = await Promise.all([
        this.agentsCache.fetch(AGENTS_KEY),
        ...LIMITS_OPERATIONS.map((operation) => this.limitsCache.fetch(operation)),
      ]);
      return joinLimits(directory, reports.flat());
    });
  }

  referencedBy(resourceId: ResourceId): CacheObservable<ReferencedByEntry[]> {
    return CacheObservable.from(this.withScope(resourceId, this.referencedByCache.observe(resourceId)), () => this.referencedByCache.fetch(resourceId));
  }

  events(resourceId: ResourceId): CacheObservable<StoredEventResponse[]> {
    return CacheObservable.from(this.withScope(resourceId, this.resourceEventsCache.observe(resourceId)), () => this.resourceEventsCache.fetch(resourceId));
  }

  // ── One-shot reads ──────────────────────────────────────────────────────

  async resourceContent(resourceId: ResourceId): Promise<string> {
    const result = await this.content.getBinary(resourceId);
    // Decode with the charset the response advertises — no blind UTF-8.
    return decodeWithCharset(result.data, result.contentType);
  }

  /**
   * Fetch the resource's JSON-LD metadata graph (descriptor + annotations +
   * inbound entity references). One-shot, uncached, dereferenced via the
   * transport's HTTP `/jsonld` face (bus-free) — the LD view an external
   * linked-data client gets. See `.plans/SIMPLER-JSON-LD.md` §5.
   */
  /**
   * A resource's coordinate map — its recovered text plus the runs that index
   * it — or `null` when none has been derived.
   *
   * Sibling of `resourceGraph`: a derived, server-computed view fetched through
   * the content transport, not the resource's bytes. Whole-resource, because a
   * consumer analysing a document needs all of it, not whichever page is on
   * screen.
   *
   * `null` is the common case and not an error. A native PDF is read in the
   * browser by pdf.js and never needs this; a media type with no extractor
   * never produces a map. Callers degrade — a PDF annotation drawn over an
   * unmapped page carries geometry with no quoted text.
   */
  async resourceAnchoredText(resourceId: ResourceId): Promise<AnchoredTextAnswer> {
    // A bus operation, not an HTTP route: the Archivist answers it and the
    // reply arrives on the bridged result channel like every other reply
    // (ANCHORED-TEXT-TO-SMELTER P3). The gateway's proxy hop is gone.
    return busRequest(
      this.transport,
      'browse:anchored-text-requested',
      { resourceId },
      this.busTimeoutMs,
    );
  }

  /**
   * The same map, addressed by the **content checksum** of the bytes it
   * derives from rather than by resource — the detection workers' read-through
   * consult (ANCHORED-TEXT-TO-SMELTER D2). Barrier-free and index-free: no
   * `views` resolution, no settle wait, because the caller already holds the
   * bytes it hashed.
   *
   * `null` is a miss and means "extract it yourself"; a stored decline is
   * served whole so a second pass runs neither parser nor engine. Read-only by
   * design — the Smelter is the only writer of this store.
   */

  async resourceGraph(resourceId: ResourceId): Promise<GetResourceResponse> {
    return this.content.getResourceGraph(resourceId);
  }

  async resourceRepresentation(
    resourceId: ResourceId,
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    return this.content.getBinary(resourceId);
  }

  async resourceRepresentationStream(
    resourceId: ResourceId,
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
    return this.content.getBinaryStream(resourceId);
  }

  async resourceEvents(resourceId: ResourceId): Promise<StoredEventResponse[]> {
    const result = await busRequest(
      this.transport,
      'browse:events-requested',
      { resourceId },
      this.busTimeoutMs,
    );
    return result.events;
  }

  async annotationHistory(resourceId: ResourceId, annotationId: AnnotationId): Promise<AnnotationHistoryResponse> {
    return busRequest(
      this.transport,
      'browse:annotation-history-requested',
      { resourceId, annotationId },
      this.busTimeoutMs,
    );
  }

  async files(
    dirPath?: string,
    sort?: 'name' | 'mtime' | 'annotationCount',
  ): Promise<components['schemas']['BrowseFilesResponse']> {
    return busRequest(
      this.transport,
      'browse:directory-requested',
      { path: dirPath ?? '.', sort: sort ?? 'name' },
      this.busTimeoutMs,
    );
  }

  async kb(): Promise<KbDescription> {
    return busRequest(this.transport, 'browse:kb-requested', {}, this.busTimeoutMs);
  }

  // ── UI signals (local bus fan-out) ────────────────────────────────────

  /**
   * Open an annotation for THIS viewer (local: panel entry selected, relayed
   * to `beckon:focus` for the scroll). The wire counterpart is
   * `beckon.click()`: open it for everyone else.
   *
   * No `motivation` parameter — the id addresses exactly one annotation and
   * the viewer derives the motivation from it (TOUR-CLICK D2). `anchorRect` is
   * viewport geometry and stays a local-only extra; it never crosses a wire.
   */
  click(annotationId: AnnotationId, anchorRect?: AnchorRect): void {
    this.bus.emit('browse:click', { annotationId, ...(anchorRect ? { anchorRect } : {}) });
  }

  openResource(resourceId: ResourceId): void {
    this.bus.emit('browse:resource-open', { resourceId });
  }

  resourceViewed(resourceId: ResourceId): void {
    // REPORT, over the wire (the beckon:focus idiom): the viewer announces
    // arrival — however the user got here — so a remote listener (the tour
    // guide's `semiont listen`) can branch on it. Deliberately a different
    // channel from the imperative `browse:resource-open` (GUIDED-TOUR D6).
    // Best-effort: a refused/failed emit (transport rejects on non-2xx and on
    // network failure) must not surface as an unhandled rejection.
    this.transport.emit('browse:resource-viewed', { resourceId }).catch(() => {});
  }

  // ── Cache-mutation API (used by the bus-event subscribers below and by
  //    other namespaces that know about specific updates) ─────────────────
  //
  //  - `invalidate*`     — SWR refetch (B7). Keeps prior value visible.
  //  - `removeAnnotationDetail` — the annotation is gone: its key fails as
  //    `bus.not-found` (B13a).
  //  - `updateAnnotationInPlace` — write-through (B13b: new value known).

  invalidateAnnotationList(resourceId: ResourceId): void {
    this.annotationListCache.invalidate(resourceId);
  }

  removeAnnotationDetail(annotationId: AnnotationId): void {
    // The routing hint stays: an observer arriving at the failed key asks the
    // service (B15), and the request needs the annotation's resource.
    if (!this.annotationDetailCache.known(annotationId)) return;
    this.annotationDetailCache.remove(
      annotationId,
      new BusRequestError(`Annotation ${annotationId} was removed`, 'bus.not-found', { annotationId }),
    );
  }

  invalidateResourceDetail(id: ResourceId): void {
    this.resourceCache.invalidate(id);
  }

  invalidateResourceLists(): void {
    this.resourceListCache.invalidateAll();
  }

  invalidateEntityTypes(): void {
    this.entityTypesCache.invalidate(ENTITY_TYPES_KEY);
  }

  invalidateTagSchemas(): void {
    this.tagSchemasCache.invalidate(TAG_SCHEMAS_KEY);
  }

  invalidateAgents(): void {
    this.agentsCache.invalidate(AGENTS_KEY);
    for (const operation of LIMITS_OPERATIONS) this.limitsCache.invalidate(operation);
  }

  /**
   * B17-Q (C1) — true when every persisted cache is quiet: no fetch in
   * flight, no debounced save pending. The session factory wires this as the
   * resumption-bookmark flush gate, making the persisted bookmark unable to
   * lead the persisted content — the invariant spec 14 caught being violated
   * (.plans/bugs/pdf-annotations-vanish-after-reload-stale-persisted-cache.md).
   */
  persistenceSettled(): boolean {
    return this.persistedCaches.every((cache) => !cache.persistencePending());
  }

  invalidateReferencedBy(resourceId: ResourceId): void {
    this.referencedByCache.invalidate(resourceId);
  }

  invalidateResourceEvents(resourceId: ResourceId): void {
    this.resourceEventsCache.invalidate(resourceId);
  }

  updateAnnotationInPlace(resourceId: ResourceId, annotation: Annotation): void {
    this.writeAnnotationIntoList(resourceId, annotation);
    this.writeAnnotationDetail(resourceId, annotation);
  }

  /** Write-through to the per-resource list, when the client holds it: the annotation spliced in where it was, or added. */
  private writeAnnotationIntoList(resourceId: ResourceId, annotation: Annotation): void {
    const currentList = this.annotationListCache.get(resourceId);
    if (!currentList) return;
    const idx = currentList.annotations.findIndex((a) => a.id === annotation.id);
    const nextAnnotations =
      idx >= 0
        ? currentList.annotations.map((a, i) => (i === idx ? annotation : a))
        : [...currentList.annotations, annotation];
    this.annotationListCache.set(resourceId, { ...currentList, annotations: nextAnnotations });
  }

  /** Write-through to the annotation's own key, so its observers see the new value without a refetch. */
  private writeAnnotationDetail(resourceId: ResourceId, annotation: Annotation): void {
    const aId = annotation.id;
    this.annotationResources.set(aId, resourceId);
    this.annotationDetailCache.set(aId, annotation);
  }

  // ── EventBus subscriptions ──────────────────────────────────────────────

  /**
   * Typed shorthand for `eventBus.on(channel).subscribe(handler)`.
   * Preserves per-channel payload typing so handlers read
   * `EventMap[K]` without any casts.
   */
  private on<K extends keyof EventMap>(
    channel: K,
    handler: (payload: EventMap[K]) => void,
  ): void {
    this.busSubs.push(
      (this.bus.on(channel) as {
        subscribe(fn: (p: EventMap[K]) => void): { unsubscribe(): void };
      }).subscribe(handler),
    );
  }

  /**
   * Dispose the namespace: detach every bus subscription and dispose all
   * owned caches (B16 — this namespace constructed them, so it disposes
   * them: the A7-owned rule). Every per-key observable completes, so
   * subscribers detach cleanly; a fetch/retry chain straddling disposal
   * dies quietly in the cache's own disposed guard. Idempotent. Called by
   * `SemiontClient.dispose()`.
   */
  dispose(): void {
    for (const sub of this.busSubs) sub.unsubscribe();
    this.busSubs.length = 0;
    this.invalidationWindows.dispose();
    this.resourceCache.dispose();
    this.resourceListCache.dispose();
    this.annotationListCache.dispose();
    this.annotationDetailCache.dispose();
    this.entityTypesCache.dispose();
    this.tagSchemasCache.dispose();
    this.agentsCache.dispose();
    this.limitsCache.dispose();
    this.referencedByCache.dispose();
    this.resourceEventsCache.dispose();
    this.annotationResources.clear();
    this.resourceListFilters.clear();
    this.annotationListObs.clear();
  }

  // ── What the bus, and the stream itself, do to the cache ────────────────
  //
  // specs/src/client/refresh.json says what each trigger does; this applies it.

  /** Apply the table's row for `trigger` to what `subject` names. */
  private refresh(trigger: CacheRefreshTrigger, subject: RefreshSubject = {}): void {
    const rows: readonly CacheRefresh[] = CACHE_REFRESH[trigger];
    const row = rows.find((candidate) => candidate.when === subject.when);
    if (!row) throw new Error(`The refresh table has no row for ${trigger}${subject.when ? ` (${subject.when})` : ''}`);
    for (const query of row.writes) this.write(query, subject);
    for (const query of row.removes) this.remove(query, subject);
    for (const query of row.refetches) this.refetch(query, subject, row.reach);
  }

  /** B13b: the event carries the value. */
  private write(query: CacheQuery, { resource, written }: RefreshSubject): void {
    if (!resource || !written) throw new Error(`An event that writes ${query} names a resource and carries the annotation`);
    switch (query) {
      case 'annotations':
        return this.writeAnnotationIntoList(resource, written);
      case 'annotation':
        return this.writeAnnotationDetail(resource, written);
      default:
        throw new Error(`The refresh table writes ${query}, which no event carries a value for`);
    }
  }

  /** B13a: the event says the entity is gone. */
  private remove(query: CacheQuery, { annotation }: RefreshSubject): void {
    if (query !== 'annotation') throw new Error(`The refresh table removes ${query}, which no event reports gone`);
    if (!annotation) throw new Error('An event that removes an annotation names it');
    this.removeAnnotationDetail(annotation);
  }

  /** B7: ask again, for the keys the row reaches, keeping what is shown meanwhile. */
  private refetch(query: CacheQuery, subject: RefreshSubject, reach: CacheRefresh['reach']): void {
    const resources = (cache: { keys(): ResourceId[] }): ResourceId[] =>
      reach === 'held' ? cache.keys() : subject.resource ? [subject.resource] : [];
    switch (query) {
      case 'resource':
        return resources(this.resourceCache).forEach(this.refetchKey.resource);
      case 'annotations':
        return resources(this.annotationListCache).forEach(this.refetchKey.annotations);
      case 'events':
        return resources(this.resourceEventsCache).forEach(this.refetchKey.events);
      case 'referencedBy':
        return resources(this.referencedByCache).forEach(this.refetchKey.referencedBy);
      case 'annotation':
        return this.annotationsReached(subject, reach).forEach(this.refetchKey.annotation);
      case 'resources':
        // Its keys are the lists the cache knows: `invalidateAll` reaches no other.
        return this.invalidationWindows.run('resource-lists', () => this.invalidateResourceLists());
      case 'entityTypes':
        return this.held(this.entityTypesCache, ENTITY_TYPES_KEY, 'entity-types', () => this.invalidateEntityTypes());
      case 'tagSchemas':
        return this.held(this.tagSchemasCache, TAG_SCHEMAS_KEY, 'tag-schemas', () => this.invalidateTagSchemas());
      case 'agents':
        return this.held(this.agentsCache, AGENTS_KEY, 'agents', () => this.invalidateAgents());
    }
  }

  /** The annotation the event names; when it names none, each one held of the resource it names. */
  private annotationsReached({ annotation, resource }: RefreshSubject, reach: CacheRefresh['reach']): AnnotationId[] {
    if (reach === 'held') return this.annotationDetailCache.keys();
    if (annotation) return [annotation];
    return [...this.annotationResources].flatMap(([held, of]) => (of === resource ? [held] : []));
  }

  /** Subscribe `channel`'s row of the refresh table to its events. */
  private refreshOn<K extends RefreshChannel>(channel: K): void {
    const subjectOf: (event: EventMap[K]) => RefreshSubject = SUBJECT_OF[channel];
    this.on(channel, (event) => this.refresh(channel, subjectOf(event)));
  }

  private subscribeToEvents(): void {
    for (const channel of Object.keys(SUBJECT_OF) as RefreshChannel[]) this.refreshOn(channel);

    // B13: `reopened`. The stream is `open` again having left it, which only
    // a drop does: a subscription that changes is handed over, and the state
    // stays `open` across it. Events with a position are replayed from where
    // the client left off, or `bus:resume-gap` says they could not be; the
    // rest were lost while the stream was down, and the row asks again for
    // what they feed.
    let opened = false;
    let left = false;
    this.busSubs.push(
      this.transport.state$.subscribe((state) => {
        if (state !== 'open') {
          left = opened;
          return;
        }
        if (left) this.refresh('reopened');
        opened = true;
        left = false;
      }),
    );
  }
}
