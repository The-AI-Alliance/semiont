/**
 * AnnotationStore — per-workspace observable annotation cache
 *
 * BehaviorSubject-backed store that:
 * - Populates lazily on first subscribe (no up-front fetch)
 * - Updates reactively when EventBus events arrive (no manual invalidation)
 * - Is readable from outside React
 *
 * EventBus events handled:
 * - mark:delete-ok    → remove from detail cache
 * - mark:added        → invalidate annotation list
 * - mark:removed      → invalidate annotation list + detail
 * - mark:body-updated → updateInPlace from enriched annotation + invalidate detail
 * - mark:entity-tag-added / mark:entity-tag-removed → invalidate list for resource
 *
 * NOTE: mark:body-updated arrives on the events-stream as an EnrichedResourceEvent
 * carrying the post-materialization annotation. The subscriber writes it
 * directly into the list cache via updateInPlace — no refetch, no two-path
 * model. This is the local AND remote mutation path: locally-initiated binds
 * receive the same enriched event from the events-stream as remote mutations
 * (other tab, CLI, importer). The events-stream's enrichment step (in
 * apps/backend/.../event-stream-enrichment.ts) guarantees the annotation
 * field is present for these event types.
 *
 * Token: mutable — call setTokenGetter() from the React layer when auth changes.
 */

import { BehaviorSubject, Observable } from 'rxjs';
import { map, distinctUntilChanged } from 'rxjs/operators';
import { annotationId as makeAnnotationId } from '@semiont/core';
import type { EventBus, EventMap, ResourceId, AnnotationId, AccessToken, components } from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { paths } from '@semiont/core';

type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type Annotation = components['schemas']['Annotation'];
type EnrichedResourceEvent = components['schemas']['EnrichedResourceEvent'];

export type AnnotationsListResponse = ResponseContent<paths['/resources/{id}/annotations']['get']>;
export type AnnotationDetail = ResponseContent<paths['/resources/{resourceId}/annotations/{annotationId}']['get']>;

export type TokenGetter = () => AccessToken | undefined;

export class AnnotationStore {
  /** Annotation list responses keyed by ResourceId */
  private readonly list$ = new BehaviorSubject<Map<ResourceId, AnnotationsListResponse>>(new Map<ResourceId, AnnotationsListResponse>());

  /** Individual annotation details keyed by AnnotationId */
  private readonly detail$ = new BehaviorSubject<Map<AnnotationId, AnnotationDetail>>(new Map<AnnotationId, AnnotationDetail>());

  /** Track in-flight fetches */
  private readonly fetchingList = new Set<ResourceId>();
  private readonly fetchingDetail = new Set<AnnotationId>();

  /** Memoized Observables — same instance returned for the same key */
  private readonly listObs$ = new Map<ResourceId, Observable<AnnotationsListResponse | undefined>>();
  private readonly detailObs$ = new Map<AnnotationId, Observable<AnnotationDetail | undefined>>();

  /** Mutable token getter — updated from the React layer when auth changes */
  private getToken: TokenGetter = () => undefined;

  /** Update the token getter (called from React when auth token changes) */
  setTokenGetter(getter: TokenGetter): void {
    this.getToken = getter;
  }

  constructor(
    private readonly http: SemiontApiClient,
    eventBus: EventBus,
  ) {
    eventBus.get('mark:delete-ok').subscribe((event: EventMap['mark:delete-ok']) => {
      this.removeFromDetailCache(makeAnnotationId(event.annotationId));
    });

    // Domain events are now StoredEvent — access inner ResourceEvent via .event
    eventBus.get('mark:added').subscribe((stored) => {
      if (stored.resourceId) {
        this.invalidateList(stored.resourceId);
      }
    });

    eventBus.get('mark:removed').subscribe((stored) => {
      if (stored.resourceId) {
        this.invalidateList(stored.resourceId);
      }
      this.invalidateDetail(makeAnnotationId(stored.payload.annotationId));
    });

    eventBus.get('mark:body-updated').subscribe((event) => {
      // The runtime payload arriving via the events-stream SSE auto-router
      // is an EnrichedResourceEvent — the StoredEvent extended with the
      // post-materialization annotation by the backend's enrichment step.
      // The bus-protocol channel type is the narrower backend StoredEvent
      // shape because the same channel is used internally backend-side
      // with branded types; the auto-router puts the wider wire format
      // here at runtime. Cast through unknown is the standard TS way to
      // bridge two compatible-but-not-assignable types at a single
      // narrowing boundary.
      const enriched = event as unknown as EnrichedResourceEvent;
      if (!enriched.resourceId || !enriched.annotation) return;
      this.updateInPlace(enriched.resourceId as ResourceId, enriched.annotation);
      // Detail cache: annotations cached individually become stale on body
      // mutation — invalidate so the next subscribe re-fetches.
      this.invalidateDetail(makeAnnotationId(enriched.annotation.id));
    });

    eventBus.get('mark:entity-tag-added').subscribe((stored) => {
      if (stored.resourceId) {
        this.invalidateList(stored.resourceId);
      }
    });

    eventBus.get('mark:entity-tag-removed').subscribe((stored) => {
      if (stored.resourceId) {
        this.invalidateList(stored.resourceId);
      }
    });

    // If the events-stream reconnection window exceeded the replay cap, we
    // missed events and can't know which annotations changed. Invalidate the
    // resource's list so the next subscribe does a cold refetch.
    eventBus.get('replay-window-exceeded').subscribe((event) => {
      if (event.resourceId) {
        this.invalidateList(event.resourceId as ResourceId);
      }
    });
  }

  /**
   * Get annotations for a resource as an Observable.
   * Triggers a fetch if not cached.
   */
  listForResource(resourceId: ResourceId): Observable<AnnotationsListResponse | undefined> {
    if (!this.list$.value.has(resourceId) && !this.fetchingList.has(resourceId)) {
      this.fetchList(resourceId);
    }
    let obs = this.listObs$.get(resourceId);
    if (!obs) {
      obs = this.list$.pipe(map(m => m.get(resourceId)), distinctUntilChanged());
      this.listObs$.set(resourceId, obs);
    }
    return obs;
  }

  /**
   * Get a single annotation detail as an Observable.
   * Triggers a fetch if not cached.
   */
  get(resourceId: ResourceId, annotationId: AnnotationId): Observable<AnnotationDetail | undefined> {
    if (!this.detail$.value.has(annotationId) && !this.fetchingDetail.has(annotationId)) {
      this.fetchDetail(resourceId, annotationId);
    }
    let obs = this.detailObs$.get(annotationId);
    if (!obs) {
      obs = this.detail$.pipe(map(m => m.get(annotationId)), distinctUntilChanged());
      this.detailObs$.set(annotationId, obs);
    }
    return obs;
  }

  /** Invalidate and re-fetch a resource's annotation list */
  invalidateList(resourceId: ResourceId): void {
    const next = new Map<ResourceId, AnnotationsListResponse>(this.list$.value);
    next.delete(resourceId);
    this.list$.next(next);
    this.fetchList(resourceId);
  }

  /**
   * Write an updated annotation directly into the cached list, in place.
   *
   * Called by FlowEngine.bind on bind:finished — the SSE response carries
   * the fully materialized updated annotation, so the store updates with
   * zero refetch and zero staleness.
   *
   * If the resource's list is not currently cached, this is a no-op. The
   * next subscribe will fetch fresh anyway, so there's nothing to update.
   *
   * If the annotation is not in the cached list (e.g. created on another
   * tab and we've never seen it), it is appended.
   */
  updateInPlace(resourceId: ResourceId, annotation: Annotation): void {
    const currentList = this.list$.value.get(resourceId);
    if (!currentList) return;

    const existingIdx = currentList.annotations.findIndex((a) => a.id === annotation.id);
    const nextAnnotations =
      existingIdx >= 0
        ? currentList.annotations.map((a, i) => (i === existingIdx ? annotation : a))
        : [...currentList.annotations, annotation];

    const nextList: AnnotationsListResponse = {
      ...currentList,
      annotations: nextAnnotations,
    };
    const nextMap = new Map<ResourceId, AnnotationsListResponse>(this.list$.value);
    nextMap.set(resourceId, nextList);
    this.list$.next(nextMap);
  }

  /** Invalidate a single annotation detail (re-fetched on next subscribe) */
  invalidateDetail(annotationId: AnnotationId): void {
    const next = new Map<AnnotationId, AnnotationDetail>(this.detail$.value);
    next.delete(annotationId);
    this.detail$.next(next);
  }

  /** Remove an annotation from the detail cache without re-fetching */
  private removeFromDetailCache(annotationId: AnnotationId): void {
    const next = new Map<AnnotationId, AnnotationDetail>(this.detail$.value);
    next.delete(annotationId);
    this.detail$.next(next);
  }

  private async fetchList(resourceId: ResourceId): Promise<void> {
    if (this.fetchingList.has(resourceId)) return;
    this.fetchingList.add(resourceId);
    try {
      const result = await this.http.browseAnnotations(resourceId, undefined, { auth: this.getToken() });
      const next = new Map<ResourceId, AnnotationsListResponse>(this.list$.value);
      next.set(resourceId, result);
      this.list$.next(next);
    } catch {
      // Leave cache empty
    } finally {
      this.fetchingList.delete(resourceId);
    }
  }

  private async fetchDetail(resourceId: ResourceId, annotationId: AnnotationId): Promise<void> {
    if (this.fetchingDetail.has(annotationId)) return;
    this.fetchingDetail.add(annotationId);
    try {
      const result = await this.http.browseAnnotation(resourceId, annotationId, { auth: this.getToken() });
      const next = new Map<AnnotationId, AnnotationDetail>(this.detail$.value);
      next.set(annotationId, result);
      this.detail$.next(next);
    } catch {
      // Leave cache empty
    } finally {
      this.fetchingDetail.delete(annotationId);
    }
  }
}
