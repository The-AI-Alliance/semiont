import { Observable, map } from 'rxjs';
import { annotationId as makeAnnotationId, resourceId as makeResourceId, searchQuery } from '@semiont/core';
import type {
  EventBus,
  EventMap,
  ResourceId,
  AnnotationId,
  AccessToken,
  GraphConnection,
  components,
} from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { ActorVM } from '../view-models/domain/actor-vm';
import { busRequest } from '../bus-request';
import { createCache, type Cache } from '../cache';
import type {
  BrowseNamespace as IBrowseNamespace,
  ReferencedByEntry,
  AnnotationHistoryResponse,
} from './types';

type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type StoredEventResponse = components['schemas']['StoredEventResponse'];
type EnrichedResourceEvent = components['schemas']['EnrichedResourceEvent'];

type GetResourceResponse = components['schemas']['GetResourceResponse'];
type AnnotationsListResponse = components['schemas']['GetAnnotationsResponse'];

type TokenGetter = () => AccessToken | undefined;

type ResourceListFilters = { limit?: number; archived?: boolean; search?: string };

/** Sentinel key for the singleton entity-types cache. */
const ENTITY_TYPES_KEY = '_';

export class BrowseNamespace implements IBrowseNamespace {
  // ── Caches, backed by the RxJS-native `Cache<K, V>` primitive ───────────
  //
  // Each cache encapsulates the BehaviorSubject store, in-flight guard,
  // and per-key observable memoization that was previously open-coded
  // here. Behavioral contract: `packages/api-client/docs/CACHE-SEMANTICS.md`.
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

  private readonly getToken: TokenGetter;
  private readonly actor: ActorVM;

  constructor(
    private readonly http: SemiontApiClient,
    private readonly eventBus: EventBus,
    getToken: TokenGetter,
    actor: ActorVM,
  ) {
    this.getToken = getToken;
    this.actor = actor;

    this.resourceCache = createCache<ResourceId, ResourceDescriptor>(async (id) => {
      const result = await busRequest<GetResourceResponse>(
        this.actor,
        'browse:resource-requested',
        { resourceId: id },
        'browse:resource-result',
        'browse:resource-failed',
      );
      return result.resource;
    });

    this.resourceListCache = createCache<string, ResourceDescriptor[]>(async (key) => {
      const filters = this.resourceListFilters.get(key) ?? {};
      const search = filters.search ? searchQuery(filters.search) : undefined;
      const result = await busRequest<{ resources: ResourceDescriptor[] }>(
        this.actor,
        'browse:resources-requested',
        { search, archived: filters.archived, limit: filters.limit ?? 100, offset: 0 },
        'browse:resources-result',
        'browse:resources-failed',
      );
      return result.resources;
    });

    this.annotationListCache = createCache<ResourceId, AnnotationsListResponse>(async (resourceId) => {
      return busRequest<AnnotationsListResponse>(
        this.actor,
        'browse:annotations-requested',
        { resourceId },
        'browse:annotations-result',
        'browse:annotations-failed',
      );
    });

    this.annotationDetailCache = createCache<AnnotationId, Annotation>(async (annotationId) => {
      const resourceId = this.annotationResources.get(annotationId);
      if (!resourceId) {
        throw new Error(`Cannot fetch annotation ${annotationId}: no resourceId known`);
      }
      const result = await busRequest<{ annotation: Annotation }>(
        this.actor,
        'browse:annotation-requested',
        { resourceId, annotationId },
        'browse:annotation-result',
        'browse:annotation-failed',
      );
      return result.annotation;
    });

    this.entityTypesCache = createCache<string, string[]>(async () => {
      const result = await busRequest<{ entityTypes: string[] }>(
        this.actor,
        'browse:entity-types-requested',
        {},
        'browse:entity-types-result',
        'browse:entity-types-failed',
      );
      return result.entityTypes;
    });

    this.referencedByCache = createCache<ResourceId, ReferencedByEntry[]>(async (resourceId) => {
      const result = await busRequest<{ referencedBy: ReferencedByEntry[] }>(
        this.actor,
        'browse:referenced-by-requested',
        { resourceId },
        'browse:referenced-by-result',
        'browse:referenced-by-failed',
      );
      return result.referencedBy;
    });

    this.resourceEventsCache = createCache<ResourceId, StoredEventResponse[]>(async (resourceId) => {
      const result = await busRequest<{ events: StoredEventResponse[] }>(
        this.actor,
        'browse:events-requested',
        { resourceId },
        'browse:events-result',
        'browse:events-failed',
      );
      return result.events;
    });

    this.subscribeToEvents();
  }

  // ── Live queries ────────────────────────────────────────────────────────

  resource(resourceId: ResourceId): Observable<ResourceDescriptor | undefined> {
    return this.resourceCache.observe(resourceId);
  }

  resources(filters?: ResourceListFilters): Observable<ResourceDescriptor[] | undefined> {
    const key = JSON.stringify(filters ?? {});
    // Remember the filter blob so `invalidateResourceLists` can drive
    // per-key SWR refetches without the caller re-passing filters.
    this.resourceListFilters.set(key, filters ?? {});
    return this.resourceListCache.observe(key);
  }

  annotations(resourceId: ResourceId): Observable<Annotation[] | undefined> {
    let obs = this.annotationListObs.get(resourceId);
    if (!obs) {
      obs = this.annotationListCache.observe(resourceId).pipe(map((r) => r?.annotations));
      this.annotationListObs.set(resourceId, obs);
    }
    return obs;
  }

  annotation(resourceId: ResourceId, annotationId: AnnotationId): Observable<Annotation | undefined> {
    // Record the routing hint so the cache's fetchFn (which only sees
    // the cache key, `annotationId`) can look up the resourceId it
    // needs for the bus request.
    this.annotationResources.set(annotationId, resourceId);
    return this.annotationDetailCache.observe(annotationId);
  }

  entityTypes(): Observable<string[] | undefined> {
    return this.entityTypesCache.observe(ENTITY_TYPES_KEY);
  }

  referencedBy(resourceId: ResourceId): Observable<ReferencedByEntry[] | undefined> {
    return this.referencedByCache.observe(resourceId);
  }

  events(resourceId: ResourceId): Observable<StoredEventResponse[] | undefined> {
    return this.resourceEventsCache.observe(resourceId);
  }

  // ── One-shot reads ──────────────────────────────────────────────────────

  async resourceContent(resourceId: ResourceId): Promise<string> {
    const result = await this.http.getResourceRepresentation(resourceId, {
      accept: 'text/plain' as components['schemas']['ContentFormat'],
      auth: this.getToken(),
    });
    const decoder = new TextDecoder();
    return decoder.decode(result.data);
  }

  async resourceRepresentation(
    resourceId: ResourceId,
    options?: { accept?: string },
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    return this.http.getResourceRepresentation(resourceId, {
      accept: options?.accept as components['schemas']['ContentFormat'],
      auth: this.getToken(),
    });
  }

  async resourceRepresentationStream(
    resourceId: ResourceId,
    options?: { accept?: string },
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
    return this.http.getResourceRepresentationStream(resourceId, {
      accept: options?.accept as components['schemas']['ContentFormat'],
      auth: this.getToken(),
    });
  }

  async resourceEvents(resourceId: ResourceId): Promise<StoredEventResponse[]> {
    const result = await busRequest<{ events: StoredEventResponse[] }>(
      this.actor,
      'browse:events-requested',
      { resourceId },
      'browse:events-result',
      'browse:events-failed',
    );
    return result.events;
  }

  async annotationHistory(resourceId: ResourceId, annotationId: AnnotationId): Promise<AnnotationHistoryResponse> {
    return busRequest<AnnotationHistoryResponse>(
      this.actor,
      'browse:annotation-history-requested',
      { resourceId, annotationId },
      'browse:annotation-history-result',
      'browse:annotation-history-failed',
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
    return busRequest<components['schemas']['BrowseFilesResponse']>(
      this.actor,
      'browse:directory-requested',
      { path: dirPath ?? '.', sort: sort ?? 'name' },
      'browse:directory-result',
      'browse:directory-failed',
    );
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
    (this.eventBus.get(channel) as { subscribe(fn: (p: EventMap[K]) => void): unknown }).subscribe(handler);
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
   * Handler shared by `yield:create-ok` and `yield:update-ok`. Both
   * report a resource mutation with the resourceId as a string (not
   * yet branded), so we brand and apply the same effect as
   * `onArchiveToggled`.
   */
  private onYieldResourceMutated = (event: { resourceId: string }): void => {
    const rId = makeResourceId(event.resourceId);
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
    // `connected$: false → true` edge — the usual case is a clean
    // resume with zero missed events.
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
      // Entity-types is a KB-wide list — always refetch on any gap.
      this.invalidateEntityTypes();
    });

    this.on('mark:delete-ok', (event) => {
      this.removeAnnotationDetail(makeAnnotationId(event.annotationId));
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
      this.updateAnnotationInPlace(enriched.resourceId as ResourceId, enriched.annotation);
      this.invalidateResourceEvents(enriched.resourceId as ResourceId);
    });

    this.on('mark:entity-tag-added', this.onEntityTagChanged);
    this.on('mark:entity-tag-removed', this.onEntityTagChanged);

    this.on('replay-window-exceeded', (event) => {
      if (event.resourceId) {
        this.invalidateAnnotationList(event.resourceId as ResourceId);
      }
    });

    this.on('yield:create-ok', this.onYieldResourceMutated);
    this.on('yield:update-ok', this.onYieldResourceMutated);

    this.on('mark:archived', this.onArchiveToggled);
    this.on('mark:unarchived', this.onArchiveToggled);

    this.on('mark:entity-type-added', () => this.invalidateEntityTypes());
  }
}
