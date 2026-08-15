import { Observable, map } from 'rxjs';
import { CacheObservable } from '../awaitable';
import { annotationId as makeAnnotationId, resourceId as makeResourceId, searchQuery, decodeWithCharset } from '@semiont/core';
import type { ExtractionOutcome } from '@semiont/core';
import type {
  Annotation,
  EventBus,
  EventMap,
  ResourceDescriptor,
  ResourceId,
  AnchorRect,
  AnnotationId,
  GraphConnection,
  TagSchema,
  CollaboratorEntry,
  components,
} from '@semiont/core';
import type { ITransport, IContentTransport } from '@semiont/core';
import { busRequest } from '@semiont/core';
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
type EnrichedResourceEvent = components['schemas']['EnrichedResourceEvent'];

type GetResourceResponse = components['schemas']['GetResourceResponse'];
type AnnotationsListResponse = components['schemas']['GetAnnotationsResponse'];

type ResourceListFilters = {
  limit?: number;
  archived?: boolean;
  search?: string;
  entityType?: string;
};

/** Sentinel key for the singleton entity-types cache. */
const ENTITY_TYPES_KEY = '_';

/** Sentinel key for the singleton tag-schemas cache. */
const TAG_SCHEMAS_KEY = '_';

/** Sentinel key for the singleton collaborator-directory cache. */
const AGENTS_KEY = '_';

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
   * is a routing hint for the backend fetch, not an identity component.
   * We track the most recent resourceId per annotationId in a side-map
   * so `mark:delete-ok` (which carries only `annotationId`) can reach
   * the right cache entry. Aligns with the pre-refactor semantics.
   */
  private readonly annotationDetailCache: Cache<AnnotationId, Annotation>;
  private readonly annotationResources = new Map<AnnotationId, ResourceId>();
  private readonly entityTypesCache: Cache<string, string[]>;
  private readonly tagSchemasCache: Cache<string, TagSchema[]>;
  private readonly agentsCache: Cache<string, CollaboratorEntry[]>;
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
       * B17 — opt into cache persistence through the environment's
       * SessionStorage adapter. keyPrefix is the KB id (cache data is
       * KB-specific). Omitted = in-memory-only, today's behavior.
       */
      cachePersistence?: { storage: SessionStorage; keyPrefix: string };
    },
  ) {
    this.busTimeoutMs = options?.busTimeoutMs;

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
  // These return `CacheObservable<T>`: subscribers see `T | undefined`
  // (with `undefined` during initial load), and `await` resolves to the
  // first non-undefined value.

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
   * are `bus:resume-gap` (a backend restart with a changed roster necessarily
   * presents as an SSE gap) and a fresh `await` (which always fetches).
   */
  agents(): CacheObservable<CollaboratorEntry[]> {
    return CacheObservable.from(this.agentsCache.observe(AGENTS_KEY), () => this.agentsCache.fetch(AGENTS_KEY));
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
  async resourceAnchoredText(resourceId: ResourceId): Promise<ExtractionOutcome | null> {
    return this.content.getAnchoredText(resourceId);
  }

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

  async connections(_resourceId: ResourceId): Promise<GraphConnection[]> {
    throw new Error('Not implemented: connections endpoint does not exist yet');
  }

  async backlinks(_resourceId: ResourceId): Promise<Annotation[]> {
    throw new Error('Not implemented: backlinks endpoint does not exist yet');
  }

  async resourcesByName(_query: string, _limit?: number): Promise<ResourceDescriptor[]> {
    throw new Error('Not implemented: resourcesByName endpoint does not exist yet');
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
    this.bus.get('browse:click').next({ annotationId, ...(anchorRect ? { anchorRect } : {}) });
  }

  openResource(resourceId: ResourceId): void {
    this.bus.get('browse:resource-open').next({ resourceId });
  }

  resourceViewed(resourceId: ResourceId): void {
    // REPORT, over the wire (the beckon:focus idiom): the viewer announces
    // arrival — however the user got here — so a remote listener (the tour
    // guide's `semiont listen`) can branch on it. Deliberately a different
    // channel from the imperative `browse:resource-open` (GUIDED-TOUR D6).
    void this.transport.emit('browse:resource-viewed', { resourceId });
  }

  // ── Cache-mutation API (used by the bus-event subscribers below and by
  //    other namespaces that know about specific updates) ─────────────────
  //
  //  - `invalidate*`     — SWR refetch (B7). Keeps prior value visible.
  //  - `removeAnnotationDetail` — drops the entry (B13a: entity gone).
  //  - `updateAnnotationInPlace` — write-through (B13b: new value known).

  invalidateAnnotationList(resourceId: ResourceId): void {
    this.annotationListCache.invalidate(resourceId);
  }

  removeAnnotationDetail(annotationId: AnnotationId): void {
    this.annotationDetailCache.remove(annotationId);
    this.annotationResources.delete(annotationId);
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
    // Write-through to the per-resource list cache (splicing the
    // updated annotation into the in-memory list response).
    const currentList = this.annotationListCache.get(resourceId);
    if (currentList) {
      const idx = currentList.annotations.findIndex((a) => a.id === annotation.id);
      const nextAnnotations =
        idx >= 0
          ? currentList.annotations.map((a, i) => (i === idx ? annotation : a))
          : [...currentList.annotations, annotation];
      this.annotationListCache.set(resourceId, { ...currentList, annotations: nextAnnotations });
    }

    // And to the per-annotation detail cache, so observers of
    // `annotation(id)` see the new value without a refetch.
    const aId = makeAnnotationId(annotation.id);
    this.annotationResources.set(aId, resourceId);
    this.annotationDetailCache.set(aId, annotation);
  }

  // ── EventBus subscriptions ──────────────────────────────────────────────

  /**
   * Typed shorthand for `eventBus.get(channel).subscribe(handler)`.
   * Preserves per-channel payload typing so handlers read
   * `EventMap[K]` without any casts.
   */
  private on<K extends keyof EventMap>(
    channel: K,
    handler: (payload: EventMap[K]) => void,
  ): void {
    this.busSubs.push(
      (this.bus.get(channel) as {
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
    this.resourceCache.dispose();
    this.resourceListCache.dispose();
    this.annotationListCache.dispose();
    this.annotationDetailCache.dispose();
    this.entityTypesCache.dispose();
    this.tagSchemasCache.dispose();
    this.agentsCache.dispose();
    this.referencedByCache.dispose();
    this.resourceEventsCache.dispose();
    this.annotationResources.clear();
    this.resourceListFilters.clear();
    this.annotationListObs.clear();
  }

  /**
   * Handler shared by `mark:entity-tag-added` and `mark:entity-tag-removed`.
   * Both events carry the same effect: the annotation list, the
   * resource descriptor, and the event log for that resource all may
   * now reflect different entity tagging, so invalidate all three.
   */
  private onEntityTagChanged = (stored: { resourceId?: ResourceId }): void => {
    if (!stored.resourceId) return;
    this.invalidateAnnotationList(stored.resourceId);
    this.invalidateResourceDetail(stored.resourceId);
    this.invalidateResourceEvents(stored.resourceId);
  };

  /**
   * Handler shared by `mark:archived` and `mark:unarchived`. Both
   * change a resource's archived flag, which is stored on the resource
   * descriptor and affects the resource-list filter.
   */
  private onArchiveToggled = (stored: { resourceId?: ResourceId }): void => {
    if (!stored.resourceId) return;
    this.invalidateResourceDetail(stored.resourceId);
    this.invalidateResourceLists();
  };

  /**
   * Invalidate caches for a created/updated resource. `yield:create-ok` and
   * `yield:update-ok` both drive this and carry the resourceId at the same path
   * (`response.resourceId`) — both are correlation replies for busRequest.
   */
  private invalidateMutatedResource = (resourceId: string): void => {
    const rId = makeResourceId(resourceId);
    this.invalidateResourceDetail(rId);
    this.invalidateResourceLists();
  };

  private subscribeToEvents(): void {
    // Gap-detection contract:
    //
    // The server stamps persisted events on `/bus/subscribe` with
    // `id: p-<scope>-<seq>`. The client sends the last seen id back as
    // `Last-Event-ID` on reconnect; the server replays persisted events
    // missed during the gap. No blanket invalidation is needed on the
    // `reconnecting → open` state-machine transition — the usual case
    // is a clean resume with zero missed events.
    //
    // The server emits a `bus:resume-gap` event when it can't cover the
    // gap (retention window exceeded, scope mismatch, or unparseable
    // `Last-Event-ID`). Receiving one means the client's caches for the
    // affected scope may be stale — fall back to blanket invalidation
    // for that scope (or all scopes, if the gap carries no scope).
    this.on('bus:resume-gap', (event) => {
      const gapScope = event.scope;
      if (gapScope) {
        const rId = gapScope as ResourceId;
        this.invalidateAnnotationList(rId);
        this.invalidateResourceDetail(rId);
        this.invalidateResourceEvents(rId);
        this.invalidateReferencedBy(rId);
      } else {
        this.invalidateResourceLists();
        for (const rId of this.annotationListCache.keys()) this.invalidateAnnotationList(rId);
        for (const rId of this.resourceCache.keys()) this.invalidateResourceDetail(rId);
        for (const rId of this.resourceEventsCache.keys()) this.invalidateResourceEvents(rId);
        for (const rId of this.referencedByCache.keys()) this.invalidateReferencedBy(rId);
      }
      // Entity-types, tag-schemas, and the collaborator directory are KB-wide
      // lists — always refetch on any gap. (For the directory, a gap is its one
      // real staleness signal: a roster change means a backend restart, which
      // presents as an SSE gap.)
      this.invalidateEntityTypes();
      this.invalidateTagSchemas();
      this.invalidateAgents();
    });

    this.on('mark:delete-ok', (event) => {
      this.removeAnnotationDetail(makeAnnotationId(event.response.annotationId));
    });

    this.on('mark:added', (stored) => {
      if (stored.resourceId) {
        this.invalidateAnnotationList(stored.resourceId);
        this.invalidateResourceEvents(stored.resourceId);
      }
    });

    this.on('mark:removed', (stored) => {
      if (stored.resourceId) {
        this.invalidateAnnotationList(stored.resourceId);
        this.invalidateResourceEvents(stored.resourceId);
      }
      this.removeAnnotationDetail(makeAnnotationId(stored.payload.annotationId));
    });

    this.on('mark:body-updated', (event) => {
      const enriched = event as unknown as EnrichedResourceEvent;
      if (!enriched.resourceId || !enriched.annotation) return;
      this.updateAnnotationInPlace(enriched.resourceId as ResourceId, enriched.annotation as Annotation);
      this.invalidateResourceEvents(enriched.resourceId as ResourceId);
    });

    this.on('mark:entity-tag-added', this.onEntityTagChanged);
    this.on('mark:entity-tag-removed', this.onEntityTagChanged);

    this.on('replay-window-exceeded', (event) => {
      if (event.resourceId) {
        this.invalidateAnnotationList(event.resourceId as ResourceId);
      }
    });

    this.on('yield:create-ok', (event) => this.invalidateMutatedResource(event.response.resourceId));
    this.on('yield:update-ok', (event) => this.invalidateMutatedResource(event.response.resourceId));

    this.on('mark:archived', this.onArchiveToggled);
    this.on('mark:unarchived', this.onArchiveToggled);

    this.on('frame:entity-type-added', () => this.invalidateEntityTypes());
    this.on('frame:tag-schema-added', () => this.invalidateTagSchemas());
  }
}
