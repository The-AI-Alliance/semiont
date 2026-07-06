import { Observable, map } from 'rxjs';
import { CacheObservable } from '../awaitable';
import { annotationId as makeAnnotationId, resourceId as makeResourceId, searchQuery, decodeWithCharset } from '@semiont/core';
import type {
  Annotation,
  EventBus,
  EventMap,
  ResourceDescriptor,
  ResourceId,
  AnnotationId,
  GraphConnection,
  Motivation,
  TagSchema,
  components,
} from '@semiont/core';
import type { ITransport, IContentTransport } from '@semiont/core';
import { busRequest } from '@semiont/core';
import { createCache, type Cache } from '../cache';
import type {
  BrowseNamespace as IBrowseNamespace,
  ReferencedByEntry,
  AnnotationHistoryResponse,
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
  private readonly resourceListCache: Cache<string, ResourceDescriptor[]>;
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
  private readonly annotationListObs = new Map<ResourceId, Observable<Annotation[] | undefined>>();

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

  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
    private readonly content: IContentTransport,
    options?: { busTimeoutMs?: number },
  ) {
    this.busTimeoutMs = options?.busTimeoutMs;

    this.resourceCache = createCache<ResourceId, ResourceDescriptor>(async (id) => {
      const result = await busRequest(
        this.transport,
        'browse:resource-requested',
        { resourceId: id },
        this.busTimeoutMs,
      );
      return result.resource as ResourceDescriptor;
    });

    this.resourceListCache = createCache<string, ResourceDescriptor[]>(async (key) => {
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
      // (@id: ResourceId) at the boundary — same as resourceCache above.
      return result.resources as ResourceDescriptor[];
    });

    this.annotationListCache = createCache<ResourceId, AnnotationsListResponse>(async (resourceId) => {
      return busRequest(
        this.transport,
        'browse:annotations-requested',
        { resourceId },
        this.busTimeoutMs,
      );
    });

    this.annotationDetailCache = createCache<AnnotationId, Annotation>(async (annotationId) => {
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
    });

    this.entityTypesCache = createCache<string, string[]>(async () => {
      const result = await busRequest(
        this.transport,
        'browse:entity-types-requested',
        {},
        this.busTimeoutMs,
      );
      return result.entityTypes;
    });

    this.tagSchemasCache = createCache<string, TagSchema[]>(async () => {
      const result = await busRequest(
        this.transport,
        'browse:tag-schemas-requested',
        {},
        this.busTimeoutMs,
      );
      return result.tagSchemas;
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
   * The one-shot `await` path does NOT go through here (it resolves via the
   * cache's `fetch` — see `CacheObservable.from`'s `fetchFresh`), so a
   * one-shot read acquires no scope.
   *
   * Memoized per source so the wrapped observable is stable per key (B4/B11).
   * Each subscription calls `subscribeToResource(rId)`; the transport
   * ref-counts concurrent subscriptions for the same resource onto a single
   * SSE scope. Single-scope model unchanged — multi-scope is deferred (see
   * `.plans/MULTI-RESOURCE-SCOPE.md`).
   *
   * Scope acquisition can FAIL under that single-scope model — another
   * resource already holds the scope, which is the normal state of affairs
   * for N distinct-rid loaders mounted together (the embeddable-viewer
   * "resource per chat message" pattern). That must DEGRADE, not error the
   * live query: correlated replies are globally bridged, so the initial load
   * and all store updates still flow unscoped; only this resource's broadcast
   * invalidations are missed while degraded. Erroring instead starved every
   * such subscriber silently and permanently
   * (.plans/bugs/concurrent-browse-resource-starvation.md). Each new
   * subscription retries acquisition, so degradation is per-subscription —
   * once the scope frees, the next subscribe scopes normally.
   */
  private withScope<T>(rId: ResourceId, source: Observable<T | undefined>): Observable<T | undefined> {
    let scoped = this.scopedSources.get(source) as Observable<T | undefined> | undefined;
    if (!scoped) {
      scoped = new Observable<T | undefined>((subscriber) => {
        let release: (() => void) | null = null;
        try {
          release = this.transport.subscribeToResource(rId);
        } catch {
          // Scope held by another resource — observe unscoped (degraded).
          // Always-on warn (once per resource): silent degradation is how the
          // starvation incident stayed invisible to a full evidence chain —
          // see .plans/bugs/concurrent-browse-resource-starvation.md.
          if (!this.degradedScopeWarned.has(rId)) {
            this.degradedScopeWarned.add(rId);
            // eslint-disable-next-line no-console
            console.warn(
              `[browse DEGRADED] scope contention: observing ${rId} unscoped — its live ` +
                `per-resource invalidations are paused until the scope frees (re-subscribe ` +
                `re-attempts; real fix: .plans/MULTI-RESOURCE-SCOPE.md).`,
            );
          }
        }
        const inner = source.subscribe(subscriber);
        return () => {
          inner.unsubscribe();
          release?.();
        };
      });
      this.scopedSources.set(source, scoped);
    }
    return scoped;
  }

  /** One degradation warn per resource per namespace lifetime — signal, not spam. */
  private readonly degradedScopeWarned = new Set<ResourceId>();

  // ── Live queries ────────────────────────────────────────────────────────
  //
  // These return `CacheObservable<T>`: subscribers see `T | undefined`
  // (with `undefined` during initial load), and `await` resolves to the
  // first non-undefined value.

  resource(resourceId: ResourceId): CacheObservable<ResourceDescriptor> {
    return CacheObservable.from(this.withScope(resourceId, this.resourceCache.observe(resourceId)), () => this.resourceCache.fetch(resourceId));
  }

  resources(filters?: ResourceListFilters): CacheObservable<ResourceDescriptor[]> {
    const key = JSON.stringify(filters ?? {});
    // Remember the filter blob so `invalidateResourceLists` can drive
    // per-key SWR refetches without the caller re-passing filters.
    this.resourceListFilters.set(key, filters ?? {});
    return CacheObservable.from(this.resourceListCache.observe(key), () => this.resourceListCache.fetch(key));
  }

  annotations(resourceId: ResourceId): CacheObservable<Annotation[]> {
    let obs = this.annotationListObs.get(resourceId);
    if (!obs) {
      obs = this.annotationListCache.observe(resourceId).pipe(map((r) => r?.annotations as Annotation[] | undefined));
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

  click(annotationId: AnnotationId, motivation: Motivation): void {
    this.bus.get('browse:click').next({ annotationId, motivation });
  }

  navigateReference(resourceId: ResourceId): void {
    this.bus.get('browse:reference-navigate').next({ resourceId });
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
      // Entity-types and tag-schemas are KB-wide lists — always refetch on any gap.
      this.invalidateEntityTypes();
      this.invalidateTagSchemas();
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
