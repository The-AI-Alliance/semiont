/**
 * AnnotationStore — per-workspace observable annotation cache
 *
 * BehaviorSubject-backed store that:
 * - Populates lazily on first subscribe (no up-front fetch)
 * - Updates reactively when EventBus events arrive (no manual invalidation)
 * - Is readable from outside React
 *
 * EventBus events handled:
 * - mark:deleted      → remove from detail cache
 * - mark:added        → invalidate annotation list (SSE domain event; resourceId on BaseEvent)
 * - mark:removed      → invalidate annotation list + detail (SSE domain event)
 * - mark:body-updated → invalidate annotation list + detail (SSE domain event)
 * - mark:entity-tag-added / mark:entity-tag-removed → invalidate list for resource
 *
 * Token: mutable — call setTokenGetter() from the React layer when auth changes.
 */

import { BehaviorSubject, Observable } from 'rxjs';
import { map, distinctUntilChanged } from 'rxjs/operators';
import type { EventBus, EventMap, ResourceId, AnnotationId, AccessToken } from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { paths } from '@semiont/core';

type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;

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
    eventBus.get('mark:deleted').subscribe((event: EventMap['mark:deleted']) => {
      this.removeFromDetailCache(event.annotationId);
    });

    // AnnotationAddedEvent: resourceId is optional on BaseEvent (present for resource-scoped events)
    eventBus.get('mark:added').subscribe((event: EventMap['mark:added']) => {
      if (event.resourceId) {
        this.invalidateList(event.resourceId);
      }
    });

    // AnnotationRemovedEvent: resourceId on BaseEvent (optional), payload.annotationId
    eventBus.get('mark:removed').subscribe((event: EventMap['mark:removed']) => {
      if (event.resourceId) {
        this.invalidateList(event.resourceId);
      }
      this.invalidateDetail(event.payload.annotationId);
    });

    // AnnotationBodyUpdatedEvent: resourceId on BaseEvent (optional), payload.annotationId
    eventBus.get('mark:body-updated').subscribe((event: EventMap['mark:body-updated']) => {
      if (event.resourceId) {
        this.invalidateList(event.resourceId);
      }
      this.invalidateDetail(event.payload.annotationId);
    });

    // EntityTagAddedEvent / EntityTagRemovedEvent: resourceId is a required top-level field
    eventBus.get('mark:entity-tag-added').subscribe((event: EventMap['mark:entity-tag-added']) => {
      if (event.resourceId) {
        this.invalidateList(event.resourceId);
      }
    });

    eventBus.get('mark:entity-tag-removed').subscribe((event: EventMap['mark:entity-tag-removed']) => {
      if (event.resourceId) {
        this.invalidateList(event.resourceId);
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
    return this.list$.pipe(
      map(m => m.get(resourceId)),
      distinctUntilChanged(),
    );
  }

  /**
   * Get a single annotation detail as an Observable.
   * Triggers a fetch if not cached.
   */
  get(resourceId: ResourceId, annotationId: AnnotationId): Observable<AnnotationDetail | undefined> {
    if (!this.detail$.value.has(annotationId) && !this.fetchingDetail.has(annotationId)) {
      this.fetchDetail(resourceId, annotationId);
    }
    return this.detail$.pipe(
      map(m => m.get(annotationId)),
      distinctUntilChanged(),
    );
  }

  /** Invalidate and re-fetch a resource's annotation list */
  invalidateList(resourceId: ResourceId): void {
    const next = new Map<ResourceId, AnnotationsListResponse>(this.list$.value);
    next.delete(resourceId);
    this.list$.next(next);
    this.fetchList(resourceId);
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
