import { Observable, combineLatest, map } from 'rxjs';
import { CacheObservable } from '../awaitable';
import { decodeWithCharset } from '@semiont/core';
import type { AnchoredTextAnswer } from '@semiont/core';
import type {
  Annotation,
  EventBus,
  ResourceDescriptor,
  ResourceId,
  AnchorRect,
  AnnotationId,
  AttributedEvent,
  TagSchema,
  Collaborator,
  CollaboratorEntry,
  KbDescription,
  LimitsOperation,
  components,
} from '@semiont/core';
import type { ITransport, IContentTransport } from '@semiont/core';
import { busRequest, BusRequestError, LIMITS_OPERATIONS } from '@semiont/core';
import type { CacheQuery, CacheRefresh } from '@semiont/core';
import { CacheRefresher, ScopedSources, type QueryActs, type RefreshSubject } from '../cache-refresh';
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
  AnnotationHistoryResponse,
  ResourceList,
} from './types';
type GetResourceResponse = components['schemas']['GetResourceResponse'];
type AnnotationsListResponse = components['schemas']['GetAnnotationsResponse'];

type ResourceListFilters = {
  limit?: number;
  archived?: boolean;
  entityType?: string;
};

/** Sentinel key for the singleton entity-types cache. */
const ENTITY_TYPES_KEY = '_';

/** Sentinel key for the singleton tag-schemas cache. */
const TAG_SCHEMAS_KEY = '_';

/** Sentinel key for the singleton collaborator-directory cache. */
const AGENTS_KEY = '_';

type InferencePairLimits = components['schemas']['InferencePairLimits'];

/**
 * The live queries of specs/src/client/refresh.json this namespace answers.
 * `client.ts` holds the namespaces to answering every one between them.
 */
export const BROWSE_QUERIES = [
  'resource', 'annotations', 'annotation', 'events', 'resources', 'entityTypes', 'tagSchemas', 'agents',
] as const satisfies readonly CacheQuery[];
type BrowseQuery = (typeof BROWSE_QUERIES)[number];

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
  // and per-key observable memoization. Behavioral contract:
  // `docs/protocol/CACHE-SEMANTICS.md`.
  //
  // The caches are an implementation detail of this namespace; the public
  // surface is `resource()`, `annotations()`, etc.

  private readonly resourceCache: Cache<ResourceId, ResourceDescriptor>;
  private readonly resourceListCache: Cache<string, ResourceList>;
  private readonly annotationListCache: Cache<ResourceId, AnnotationsListResponse>;
  /**
   * Annotation-detail cache keyed by `annotationId` only — the resourceId
   * is a routing hint for the gateway fetch, not an identity component.
   * The side-map holds the most recent resourceId per annotationId: the
   * fetch names it in its request, and an event that names only a resource
   * finds that resource's annotations through it.
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
  private readonly resourceEventsCache: Cache<ResourceId, AttributedEvent[]>;

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

  /** Subscribing to a resource-scoped query acquires the resource's scope. */
  private readonly scoped: ScopedSources;

  /**
   * Timeout passed to every `busRequest` this namespace issues. `undefined`
   * means `busRequest`'s default (30 s). Injectable so the liveness
   * properties can run the real composition on
   * deterministic virtual time — the same knob `HttpTransportConfig.timeout`
   * provides at the HTTP layer.
   */
  private readonly busTimeoutMs: number | undefined;

  /** Applies the refresh table to this namespace's queries; B16 detaches it. */
  private readonly refresher: CacheRefresher<BrowseQuery>;

  /**
   * Ask again for one key, as a row of the refresh table says to. Only a key
   * the cache knows (B20): an event about a key nothing has asked for has
   * nothing to refresh, and refreshing it anyway costs every viewer a request
   * per resource another principal imports. Each goes through its key's
   * window (B19). The public `invalidate*` methods stay immediate, and fetch
   * whatever the key holds (B8), for direct callers.
   */
  private readonly refetchKey = {
    resource: (rId: ResourceId) => this.refresher.held(this.resourceCache, rId, `resource/${rId}`, () => this.invalidateResourceDetail(rId)),
    annotations: (rId: ResourceId) => this.refresher.held(this.annotationListCache, rId, `annotations/${rId}`, () => this.invalidateAnnotationList(rId)),
    annotation: (aId: AnnotationId) => this.refresher.held(this.annotationDetailCache, aId, `annotation/${aId}`, () => this.annotationDetailCache.invalidate(aId)),
    events: (rId: ResourceId) => this.refresher.held(this.resourceEventsCache, rId, `events/${rId}`, () => this.invalidateResourceEvents(rId)),
  };

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
       * KB-specific). Omitted = in-memory only.
       */
      cachePersistence?: { storage: SessionStorage; keyPrefix: string };
    },
  ) {
    this.busTimeoutMs = options?.busTimeoutMs;
    this.scoped = new ScopedSources(this.transport);

    // The opt-in table: the small, first-paint caches persist (a resource,
    // its annotations, one annotation, the vocabulary); resource lists, event
    // histories, referenced-by and the collaborator directory stay in-memory.
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
      const result = await busRequest(
        this.transport,
        'browse:resources-requested',
        {
          archived: filters.archived,
          entityType: filters.entityType,
          limit: filters.limit ?? 100,
          offset: 0,
        },
        this.busTimeoutMs,
      );
      // Brand the wire type (unbranded @id: string) to the SDK's ResourceDescriptor
      // (@id: ResourceId) at the boundary — same as resourceCache above.
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
      // capability field is the point of the wrapper.
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

    this.resourceEventsCache = createCache<ResourceId, AttributedEvent[]>(async (resourceId) => {
      const result = await busRequest(
        this.transport,
        'browse:events-requested',
        { resourceId },
        this.busTimeoutMs,
      );
      return result.events;
    });

    this.refresher = new CacheRefresher<BrowseQuery>(this.transport, this.bus, this.refreshActs(), options?.invalidationWindowMs);
  }

  // ── Live queries ────────────────────────────────────────────────────────
  //
  // These return `CacheObservable<T>`: subscribers see `CacheState<T>`
  // (`pending` during initial load), and `.fresh()` is the one-shot read.

  resource(resourceId: ResourceId): CacheObservable<ResourceDescriptor> {
    return CacheObservable.from(this.scoped.of(resourceId, this.resourceCache.observe(resourceId)), () => this.resourceCache.fetch(resourceId));
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
    return CacheObservable.from(this.scoped.of(resourceId, obs), () => this.annotationListCache.fetch(resourceId).then((r) => r.annotations as Annotation[]));
  }

  annotation(resourceId: ResourceId, annotationId: AnnotationId): CacheObservable<Annotation> {
    // Record the routing hint so the cache's fetchFn (which only sees
    // the cache key, `annotationId`) can look up the resourceId it
    // needs for the bus request.
    this.annotationResources.set(annotationId, resourceId);
    return CacheObservable.from(this.scoped.of(resourceId, this.annotationDetailCache.observe(annotationId)), () => this.annotationDetailCache.fetch(annotationId));
  }

  entityTypes(): CacheObservable<string[]> {
    return CacheObservable.from(this.entityTypesCache.observe(ENTITY_TYPES_KEY), () => this.entityTypesCache.fetch(ENTITY_TYPES_KEY));
  }

  tagSchemas(): CacheObservable<TagSchema[]> {
    return CacheObservable.from(this.tagSchemasCache.observe(TAG_SCHEMAS_KEY), () => this.tagSchemasCache.fetch(TAG_SCHEMAS_KEY));
  }

  /**
   * The KB's collaborator directory: its declared software agents (from the
   * KB's worker/actor config, with `servesJobTypes` capabilities). Its
   * members (Persons) are not listed. KB-wide singleton, cached for the
   * client's lifetime; no membership-change event exists, so the only refresh
   * triggers are the stream reopening after a drop (a gateway restart with a
   * changed roster presents as one) and `.fresh()` (which always fetches).
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

  events(resourceId: ResourceId): CacheObservable<AttributedEvent[]> {
    return CacheObservable.from(this.scoped.of(resourceId, this.resourceEventsCache.observe(resourceId)), () => this.resourceEventsCache.fetch(resourceId));
  }

  // ── One-shot reads ──────────────────────────────────────────────────────

  async resourceContent(resourceId: ResourceId): Promise<string> {
    const result = await this.content.getBinary(resourceId);
    // Decode with the charset the response advertises — no blind UTF-8.
    return decodeWithCharset(result.data, result.contentType);
  }

  /**
   * A resource's coordinate map — its recovered text plus the runs that index
   * it — a stored decline, or a named absence. Never `null`.
   *
   * A derived, server-computed view, not the resource's bytes, asked over the
   * bus (`browse:anchored-text-requested`). Whole-resource, because a
   * consumer analysing a document needs all of it, not whichever page is on
   * screen.
   *
   * An absence is not an error, and its `kind` says whether to come back:
   * `not-yet` (the Smelter has not settled this content; retry), `no-map`
   * (the media type derives no geometry) or `unknown` (the resource has no
   * content identity). Callers degrade — a PDF annotation drawn over an
   * unmapped page carries geometry with no quoted text.
   */
  async resourceAnchoredText(resourceId: ResourceId): Promise<AnchoredTextAnswer> {
    // A bus operation, not an HTTP route: the Archivist answers it and the
    // reply arrives on the bridged result channel like every other reply.
    return busRequest(
      this.transport,
      'browse:anchored-text-requested',
      { resourceId },
      this.busTimeoutMs,
    );
  }

  /**
   * Fetch the resource's JSON-LD metadata graph (descriptor + annotations +
   * inbound entity references). One-shot, uncached, dereferenced via the
   * transport's HTTP `/jsonld` face (bus-free) — the LD view an external
   * linked-data client gets.
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

  async resourceEvents(resourceId: ResourceId): Promise<AttributedEvent[]> {
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
   * the viewer derives the motivation from it. `anchorRect` is viewport
   * geometry and stays a local-only extra; it never crosses a wire.
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
    // channel from the imperative `browse:resource-open`, so one viewer's
    // own navigation cannot drive another's page.
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
   * lead the persisted content.
   */
  persistenceSettled(): boolean {
    return this.persistedCaches.every((cache) => !cache.persistencePending());
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

  /**
   * Dispose the namespace: detach every bus subscription and dispose all
   * owned caches (B16 — this namespace constructed them, so it disposes
   * them: the A7-owned rule). Every per-key observable completes, so
   * subscribers detach cleanly; a fetch/retry chain straddling disposal
   * dies quietly in the cache's own disposed guard. Idempotent. Called by
   * `SemiontClient.dispose()`.
   */
  dispose(): void {
    this.refresher.dispose();
    this.resourceCache.dispose();
    this.resourceListCache.dispose();
    this.annotationListCache.dispose();
    this.annotationDetailCache.dispose();
    this.entityTypesCache.dispose();
    this.tagSchemasCache.dispose();
    this.agentsCache.dispose();
    this.limitsCache.dispose();
    this.resourceEventsCache.dispose();
    this.annotationResources.clear();
    this.resourceListFilters.clear();
    this.annotationListObs.clear();
  }

  // ── What the bus, and the stream itself, do to the cache ────────────────
  //
  // specs/src/client/refresh.json says what each trigger does; the refresher
  // applies its rows to these.

  private refreshActs(): Record<BrowseQuery, QueryActs> {
    const resources = (cache: { keys(): ResourceId[] }, subject: RefreshSubject, reach: CacheRefresh['reach']): ResourceId[] =>
      reach === 'held' ? cache.keys() : subject.resource ? [subject.resource] : [];
    // B13b: the event carries the value.
    const written = (query: BrowseQuery, { resource, written }: RefreshSubject): { resource: ResourceId; written: Annotation } => {
      if (!resource || !written) throw new Error(`An event that writes ${query} names a resource and carries the annotation`);
      return { resource, written };
    };
    return {
      resource: { refetch: (subject, reach) => resources(this.resourceCache, subject, reach).forEach(this.refetchKey.resource) },
      annotations: {
        refetch: (subject, reach) => resources(this.annotationListCache, subject, reach).forEach(this.refetchKey.annotations),
        write: (subject) => {
          const { resource, written: annotation } = written('annotations', subject);
          this.writeAnnotationIntoList(resource, annotation);
        },
      },
      annotation: {
        refetch: (subject, reach) => this.annotationsReached(subject, reach).forEach(this.refetchKey.annotation),
        write: (subject) => {
          const { resource, written: annotation } = written('annotation', subject);
          this.writeAnnotationDetail(resource, annotation);
        },
        // B13a: the event says the entity is gone.
        remove: ({ annotation }) => {
          if (!annotation) throw new Error('An event that removes an annotation names it');
          this.removeAnnotationDetail(annotation);
        },
      },
      events: { refetch: (subject, reach) => resources(this.resourceEventsCache, subject, reach).forEach(this.refetchKey.events) },
      // Its keys are the lists the cache knows: `invalidateAll` reaches no other.
      resources: { refetch: () => this.refresher.windowed('resource-lists', () => this.invalidateResourceLists()) },
      entityTypes: { refetch: () => this.refresher.held(this.entityTypesCache, ENTITY_TYPES_KEY, 'entity-types', () => this.invalidateEntityTypes()) },
      tagSchemas: { refetch: () => this.refresher.held(this.tagSchemasCache, TAG_SCHEMAS_KEY, 'tag-schemas', () => this.invalidateTagSchemas()) },
      agents: { refetch: () => this.refresher.held(this.agentsCache, AGENTS_KEY, 'agents', () => this.invalidateAgents()) },
    };
  }

  /** The annotation the event names; when it names none, each one held of the resource it names. */
  private annotationsReached({ annotation, resource }: RefreshSubject, reach: CacheRefresh['reach']): AnnotationId[] {
    if (reach === 'held') return this.annotationDetailCache.keys();
    if (annotation) return [annotation];
    return [...this.annotationResources].flatMap(([held, of]) => (of === resource ? [held] : []));
  }
}
