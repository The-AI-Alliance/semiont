/**
 * BrowseNamespace — reads from materialized views
 *
 * Absorbs AnnotationStore and ResourceStore logic. Live queries return
 * Observables backed by BehaviorSubjects that update reactively when
 * EventBus events arrive. One-shot reads are Promise wrappers over HTTP.
 *
 * Backend actor: Browser (context classes)
 * Event prefix: browse:*
 */

import { BehaviorSubject, Observable } from 'rxjs';
import { map, distinctUntilChanged } from 'rxjs/operators';
import { annotationId as makeAnnotationId, resourceId as makeResourceId, searchQuery } from '@semiont/core';
import type {
  EventBus,
  EventMap,
  ResourceId,
  AnnotationId,
  AccessToken,
  GraphConnection,
  components,
  paths,
} from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type {
  BrowseNamespace as IBrowseNamespace,
  ReferencedByEntry,
  AnnotationHistoryResponse,
  ResponseContent,
} from './types';

type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type StoredEventResponse = components['schemas']['StoredEventResponse'];
type EnrichedResourceEvent = components['schemas']['EnrichedResourceEvent'];

// Response types extracted from OpenAPI schemas.
// Note: GET /resources/{id} uses application/ld+json, not application/json,
// so the generic ResponseContent helper resolves to `never` for it.
// We reference the schema type directly instead.
type GetResourceResponse = components['schemas']['GetResourceResponse'];
type AnnotationsListResponse = ResponseContent<paths['/resources/{id}/annotations']['get']>;

type TokenGetter = () => AccessToken | undefined;

export class BrowseNamespace implements IBrowseNamespace {
  // ── Annotation list cache ───────────────────────────────────────────────
  private readonly annotationList$ = new BehaviorSubject<Map<ResourceId, AnnotationsListResponse>>(new Map());
  private readonly fetchingAnnotationList = new Set<ResourceId>();
  private readonly annotationListObs$ = new Map<ResourceId, Observable<Annotation[] | undefined>>();

  // ── Annotation detail cache ─────────────────────────────────────────────
  private readonly annotationDetail$ = new BehaviorSubject<Map<AnnotationId, Annotation>>(new Map());
  private readonly fetchingAnnotationDetail = new Set<AnnotationId>();
  private readonly annotationDetailObs$ = new Map<AnnotationId, Observable<Annotation | undefined>>();

  // ── Resource detail cache ───────────────────────────────────────────────
  private readonly resourceDetail$ = new BehaviorSubject<Map<ResourceId, ResourceDescriptor>>(new Map());
  private readonly fetchingResourceDetail = new Set<ResourceId>();
  private readonly resourceDetailObs$ = new Map<ResourceId, Observable<ResourceDescriptor | undefined>>();

  // ── Resource list cache ─────────────────────────────────────────────────
  private readonly resourceList$ = new BehaviorSubject<Map<string, ResourceDescriptor[]>>(new Map());
  private readonly fetchingResourceList = new Set<string>();
  private readonly resourceListObs$ = new Map<string, Observable<ResourceDescriptor[] | undefined>>();

  // ── Entity types cache ──────────────────────────────────────────────────
  private readonly entityTypes$ = new BehaviorSubject<string[] | undefined>(undefined);
  private fetchingEntityTypes = false;

  // ── Referenced-by cache ─────────────────────────────────────────────────
  private readonly referencedBy$ = new BehaviorSubject<Map<ResourceId, ReferencedByEntry[]>>(new Map());
  private readonly fetchingReferencedBy = new Set<ResourceId>();
  private readonly referencedByObs$ = new Map<ResourceId, Observable<ReferencedByEntry[] | undefined>>();

  // ── Resource events cache ──────────────────────────────────────────────
  private readonly resourceEvents$ = new BehaviorSubject<Map<ResourceId, StoredEventResponse[]>>(new Map());
  private readonly fetchingResourceEvents = new Set<ResourceId>();
  private readonly resourceEventsObs$ = new Map<ResourceId, Observable<StoredEventResponse[] | undefined>>();

  private readonly getToken: TokenGetter;

  constructor(
    private readonly http: SemiontApiClient,
    private readonly eventBus: EventBus,
    getToken: TokenGetter,
  ) {
    this.getToken = getToken;
    this.subscribeToEvents();
  }

  // ── Live queries ────────────────────────────────────────────────────────

  resource(resourceId: ResourceId): Observable<ResourceDescriptor | undefined> {
    if (!this.resourceDetail$.value.has(resourceId) && !this.fetchingResourceDetail.has(resourceId)) {
      this.fetchResourceDetail(resourceId);
    }
    let obs = this.resourceDetailObs$.get(resourceId);
    if (!obs) {
      obs = this.resourceDetail$.pipe(map(m => m.get(resourceId)), distinctUntilChanged());
      this.resourceDetailObs$.set(resourceId, obs);
    }
    return obs;
  }

  resources(filters?: { limit?: number; archived?: boolean; search?: string }): Observable<ResourceDescriptor[] | undefined> {
    const key = JSON.stringify(filters ?? {});
    if (!this.resourceList$.value.has(key) && !this.fetchingResourceList.has(key)) {
      this.fetchResourceList(key, filters);
    }
    let obs = this.resourceListObs$.get(key);
    if (!obs) {
      obs = this.resourceList$.pipe(map(m => m.get(key)), distinctUntilChanged());
      this.resourceListObs$.set(key, obs);
    }
    return obs;
  }

  annotations(resourceId: ResourceId): Observable<Annotation[] | undefined> {
    if (!this.annotationList$.value.has(resourceId) && !this.fetchingAnnotationList.has(resourceId)) {
      this.fetchAnnotationList(resourceId);
    }
    let obs = this.annotationListObs$.get(resourceId);
    if (!obs) {
      obs = this.annotationList$.pipe(
        map(m => m.get(resourceId)?.annotations),
        distinctUntilChanged(),
      );
      this.annotationListObs$.set(resourceId, obs);
    }
    return obs;
  }

  annotation(resourceId: ResourceId, annotationId: AnnotationId): Observable<Annotation | undefined> {
    if (!this.annotationDetail$.value.has(annotationId) && !this.fetchingAnnotationDetail.has(annotationId)) {
      this.fetchAnnotationDetail(resourceId, annotationId);
    }
    let obs = this.annotationDetailObs$.get(annotationId);
    if (!obs) {
      obs = this.annotationDetail$.pipe(map(m => m.get(annotationId)), distinctUntilChanged());
      this.annotationDetailObs$.set(annotationId, obs);
    }
    return obs;
  }

  entityTypes(): Observable<string[] | undefined> {
    if (this.entityTypes$.value === undefined && !this.fetchingEntityTypes) {
      this.fetchEntityTypes();
    }
    return this.entityTypes$.asObservable();
  }

  referencedBy(resourceId: ResourceId): Observable<ReferencedByEntry[] | undefined> {
    if (!this.referencedBy$.value.has(resourceId) && !this.fetchingReferencedBy.has(resourceId)) {
      this.fetchReferencedBy(resourceId);
    }
    let obs = this.referencedByObs$.get(resourceId);
    if (!obs) {
      obs = this.referencedBy$.pipe(map(m => m.get(resourceId)), distinctUntilChanged());
      this.referencedByObs$.set(resourceId, obs);
    }
    return obs;
  }

  events(resourceId: ResourceId): Observable<StoredEventResponse[] | undefined> {
    if (!this.resourceEvents$.value.has(resourceId) && !this.fetchingResourceEvents.has(resourceId)) {
      this.fetchResourceEventsCache(resourceId);
    }
    let obs = this.resourceEventsObs$.get(resourceId);
    if (!obs) {
      obs = this.resourceEvents$.pipe(map(m => m.get(resourceId)), distinctUntilChanged());
      this.resourceEventsObs$.set(resourceId, obs);
    }
    return obs;
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
    const result = await this.http.getResourceEvents(resourceId, { auth: this.getToken() });
    return result.events;
  }

  async annotationHistory(resourceId: ResourceId, annotationId: AnnotationId): Promise<AnnotationHistoryResponse> {
    return this.http.getAnnotationHistory(resourceId, annotationId, { auth: this.getToken() });
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
  ): Promise<ResponseContent<paths['/api/browse/files']['get']>> {
    return this.http.browseFiles(dirPath, sort, { auth: this.getToken() });
  }

  // ── Invalidation (exposed for other namespaces) ─────────────────────────

  invalidateAnnotationList(resourceId: ResourceId): void {
    const next = new Map(this.annotationList$.value);
    next.delete(resourceId);
    this.annotationList$.next(next);
    this.fetchAnnotationList(resourceId);
  }

  invalidateAnnotationDetail(annotationId: AnnotationId): void {
    const next = new Map(this.annotationDetail$.value);
    next.delete(annotationId);
    this.annotationDetail$.next(next);
  }

  invalidateResourceDetail(id: ResourceId): void {
    const next = new Map(this.resourceDetail$.value);
    next.delete(id);
    this.resourceDetail$.next(next);
    this.fetchResourceDetail(id);
  }

  invalidateResourceLists(): void {
    this.resourceList$.next(new Map());
  }

  invalidateEntityTypes(): void {
    this.entityTypes$.next(undefined);
    this.fetchEntityTypes();
  }

  invalidateReferencedBy(resourceId: ResourceId): void {
    const next = new Map(this.referencedBy$.value);
    next.delete(resourceId);
    this.referencedBy$.next(next);
    this.fetchReferencedBy(resourceId);
  }

  invalidateResourceEvents(resourceId: ResourceId): void {
    const next = new Map(this.resourceEvents$.value);
    next.delete(resourceId);
    this.resourceEvents$.next(next);
    this.fetchResourceEventsCache(resourceId);
  }

  updateAnnotationInPlace(resourceId: ResourceId, annotation: Annotation): void {
    const currentList = this.annotationList$.value.get(resourceId);
    if (!currentList) return;

    const existingIdx = currentList.annotations.findIndex((a) => a.id === annotation.id);
    const nextAnnotations =
      existingIdx >= 0
        ? currentList.annotations.map((a, i) => (i === existingIdx ? annotation : a))
        : [...currentList.annotations, annotation];

    const nextList: AnnotationsListResponse = { ...currentList, annotations: nextAnnotations };
    const nextMap = new Map(this.annotationList$.value);
    nextMap.set(resourceId, nextList);
    this.annotationList$.next(nextMap);
  }

  // ── EventBus subscriptions ──────────────────────────────────────────────

  private subscribeToEvents(): void {
    const bus = this.eventBus;

    // Annotation events
    bus.get('mark:delete-ok').subscribe((event: EventMap['mark:delete-ok']) => {
      this.invalidateAnnotationDetail(makeAnnotationId(event.annotationId));
    });

    bus.get('mark:added').subscribe((stored) => {
      if (stored.resourceId) {
        this.invalidateAnnotationList(stored.resourceId);
        this.invalidateResourceEvents(stored.resourceId);
      }
    });

    bus.get('mark:removed').subscribe((stored) => {
      if (stored.resourceId) {
        this.invalidateAnnotationList(stored.resourceId);
        this.invalidateResourceEvents(stored.resourceId);
      }
      this.invalidateAnnotationDetail(makeAnnotationId(stored.payload.annotationId));
    });

    bus.get('mark:body-updated').subscribe((event) => {
      const enriched = event as unknown as EnrichedResourceEvent;
      if (!enriched.resourceId || !enriched.annotation) return;
      this.updateAnnotationInPlace(enriched.resourceId as ResourceId, enriched.annotation);
      this.invalidateAnnotationDetail(makeAnnotationId(enriched.annotation.id));
      this.invalidateResourceEvents(enriched.resourceId as ResourceId);
    });

    bus.get('mark:entity-tag-added').subscribe((stored) => {
      if (stored.resourceId) {
        this.invalidateAnnotationList(stored.resourceId);
        this.invalidateResourceDetail(stored.resourceId);
        this.invalidateResourceEvents(stored.resourceId);
      }
    });

    bus.get('mark:entity-tag-removed').subscribe((stored) => {
      if (stored.resourceId) {
        this.invalidateAnnotationList(stored.resourceId);
        this.invalidateResourceDetail(stored.resourceId);
        this.invalidateResourceEvents(stored.resourceId);
      }
    });

    bus.get('replay-window-exceeded').subscribe((event) => {
      if (event.resourceId) {
        this.invalidateAnnotationList(event.resourceId as ResourceId);
      }
    });

    // Resource events
    bus.get('yield:create-ok').subscribe((event: EventMap['yield:create-ok']) => {
      this.fetchResourceDetail(makeResourceId(event.resourceId));
      this.invalidateResourceLists();
    });

    bus.get('yield:update-ok').subscribe((event: EventMap['yield:update-ok']) => {
      this.invalidateResourceDetail(makeResourceId(event.resourceId));
      this.invalidateResourceLists();
    });

    bus.get('mark:archived').subscribe((stored) => {
      if (stored.resourceId) {
        this.invalidateResourceDetail(stored.resourceId);
        this.invalidateResourceLists();
      }
    });

    bus.get('mark:unarchived').subscribe((stored) => {
      if (stored.resourceId) {
        this.invalidateResourceDetail(stored.resourceId);
        this.invalidateResourceLists();
      }
    });

    // Entity types (via global-events-stream)
    bus.get('mark:entity-type-added').subscribe(() => {
      this.invalidateEntityTypes();
    });
  }

  // ── Fetch helpers ───────────────────────────────────────────────────────

  private async fetchAnnotationList(resourceId: ResourceId): Promise<void> {
    if (this.fetchingAnnotationList.has(resourceId)) return;
    this.fetchingAnnotationList.add(resourceId);
    try {
      const result = await this.http.browseAnnotations(resourceId, undefined, { auth: this.getToken() });
      const next = new Map(this.annotationList$.value);
      next.set(resourceId, result);
      this.annotationList$.next(next);
    } catch {
      // Leave cache empty
    } finally {
      this.fetchingAnnotationList.delete(resourceId);
    }
  }

  private async fetchAnnotationDetail(resourceId: ResourceId, annotationId: AnnotationId): Promise<void> {
    if (this.fetchingAnnotationDetail.has(annotationId)) return;
    this.fetchingAnnotationDetail.add(annotationId);
    try {
      const result = await this.http.browseAnnotation(resourceId, annotationId, { auth: this.getToken() });
      const next = new Map(this.annotationDetail$.value);
      next.set(annotationId, result.annotation);
      this.annotationDetail$.next(next);
    } catch {
      // Leave cache empty
    } finally {
      this.fetchingAnnotationDetail.delete(annotationId);
    }
  }

  private async fetchResourceDetail(id: ResourceId): Promise<void> {
    if (this.fetchingResourceDetail.has(id)) return;
    this.fetchingResourceDetail.add(id);
    try {
      // browseResource returns GetResourceResponse (application/ld+json),
      // but ResponseContent resolves to `never` for non-application/json
      // content types. Cast through the schema type directly.
      const result = await this.http.browseResource(id, { auth: this.getToken() }) as unknown as GetResourceResponse;
      const next = new Map(this.resourceDetail$.value);
      next.set(id, result.resource);
      this.resourceDetail$.next(next);
    } catch {
      // Leave cache empty
    } finally {
      this.fetchingResourceDetail.delete(id);
    }
  }

  private async fetchResourceList(key: string, filters?: { limit?: number; archived?: boolean; search?: string }): Promise<void> {
    if (this.fetchingResourceList.has(key)) return;
    this.fetchingResourceList.add(key);
    try {
      const search = filters?.search ? searchQuery(filters.search) : undefined;
      const result = await this.http.browseResources(filters?.limit, filters?.archived, search, { auth: this.getToken() });
      const next = new Map(this.resourceList$.value);
      next.set(key, result.resources);
      this.resourceList$.next(next);
    } catch {
      // Leave cache empty
    } finally {
      this.fetchingResourceList.delete(key);
    }
  }

  private async fetchEntityTypes(): Promise<void> {
    if (this.fetchingEntityTypes) return;
    this.fetchingEntityTypes = true;
    try {
      const result = await this.http.listEntityTypes({ auth: this.getToken() });
      this.entityTypes$.next(result.entityTypes);
    } catch {
      // Leave cache empty
    } finally {
      this.fetchingEntityTypes = false;
    }
  }

  private async fetchReferencedBy(resourceId: ResourceId): Promise<void> {
    if (this.fetchingReferencedBy.has(resourceId)) return;
    this.fetchingReferencedBy.add(resourceId);
    try {
      const result = await this.http.browseReferences(resourceId, { auth: this.getToken() });
      const next = new Map(this.referencedBy$.value);
      next.set(resourceId, result.referencedBy);
      this.referencedBy$.next(next);
    } catch {
      // Leave cache empty
    } finally {
      this.fetchingReferencedBy.delete(resourceId);
    }
  }

  private async fetchResourceEventsCache(resourceId: ResourceId): Promise<void> {
    if (this.fetchingResourceEvents.has(resourceId)) return;
    this.fetchingResourceEvents.add(resourceId);
    try {
      const result = await this.http.getResourceEvents(resourceId, { auth: this.getToken() });
      const next = new Map(this.resourceEvents$.value);
      next.set(resourceId, result.events);
      this.resourceEvents$.next(next);
    } catch {
      // Leave cache empty
    } finally {
      this.fetchingResourceEvents.delete(resourceId);
    }
  }
}
