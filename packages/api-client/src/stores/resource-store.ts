/**
 * ResourceStore — per-workspace observable resource cache
 *
 * BehaviorSubject-backed store that:
 * - Populates lazily on first subscribe (no up-front fetch)
 * - Updates reactively when EventBus events arrive (no manual invalidation)
 * - Is readable from outside React
 *
 * EventBus events handled:
 * - yield:created       → fetch new resource into map, invalidate lists
 * - mark:archived       → invalidate resource detail + lists
 * - mark:unarchived     → invalidate resource detail + lists
 * - mark:entity-tag-added / mark:entity-tag-removed → invalidate resource detail
 *
 * Token: mutable — call setTokenGetter() from the React layer when auth changes.
 */

import { BehaviorSubject, Observable } from 'rxjs';
import { map, distinctUntilChanged } from 'rxjs/operators';
import type { EventBus, EventMap, ResourceId, AccessToken } from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { paths } from '@semiont/core';

type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;

export type ResourceDetail = ResponseContent<paths['/resources/{id}']['get']>;
export type ResourceListResponse = ResponseContent<paths['/resources']['get']>;

export type TokenGetter = () => AccessToken | undefined;

export class ResourceStore {
  /** Cache of individual resource details, keyed by ResourceId */
  private readonly detail$ = new BehaviorSubject<Map<ResourceId, ResourceDetail>>(new Map<ResourceId, ResourceDetail>());

  /** Cache of list responses, keyed by a serialized options string */
  private readonly list$ = new BehaviorSubject<Map<string, ResourceListResponse>>(new Map<string, ResourceListResponse>());

  /** Track in-flight fetches to avoid duplicate requests */
  private readonly fetchingDetail = new Set<ResourceId>();
  private readonly fetchingList = new Set<string>();

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
    eventBus.get('yield:created').subscribe((event: EventMap['yield:created']) => {
      this.fetchDetail(event.resourceId);
      this.invalidateLists();
    });

    eventBus.get('yield:updated').subscribe((event: EventMap['yield:updated']) => {
      this.invalidateDetail(event.resourceId);
      this.invalidateLists();
    });

    // resourceId is optional on BaseEvent — present for resource-scoped events
    eventBus.get('mark:archived').subscribe((event: EventMap['mark:archived']) => {
      if (event.resourceId) {
        this.invalidateDetail(event.resourceId);
        this.invalidateLists();
      }
    });

    eventBus.get('mark:unarchived').subscribe((event: EventMap['mark:unarchived']) => {
      if (event.resourceId) {
        this.invalidateDetail(event.resourceId);
        this.invalidateLists();
      }
    });

    // EntityTagAddedEvent / EntityTagRemovedEvent have resourceId as a top-level field
    eventBus.get('mark:entity-tag-added').subscribe((event: EventMap['mark:entity-tag-added']) => {
      if (event.resourceId) {
        this.invalidateDetail(event.resourceId);
      }
    });

    eventBus.get('mark:entity-tag-removed').subscribe((event: EventMap['mark:entity-tag-removed']) => {
      if (event.resourceId) {
        this.invalidateDetail(event.resourceId);
      }
    });
  }

  /**
   * Get a single resource by ID as an Observable.
   * Triggers a fetch if not cached.
   */
  get(id: ResourceId): Observable<ResourceDetail | undefined> {
    if (!this.detail$.value.has(id) && !this.fetchingDetail.has(id)) {
      this.fetchDetail(id);
    }
    return this.detail$.pipe(
      map(m => m.get(id)),
      distinctUntilChanged(),
    );
  }

  /**
   * List resources as an Observable.
   * Triggers a fetch if not cached.
   */
  list(options?: { limit?: number; archived?: boolean }): Observable<ResourceListResponse | undefined> {
    const key = JSON.stringify(options ?? {});
    if (!this.list$.value.has(key) && !this.fetchingList.has(key)) {
      this.fetchList(key, options);
    }
    return this.list$.pipe(
      map(m => m.get(key)),
      distinctUntilChanged(),
    );
  }

  /** Invalidate and re-fetch a specific resource detail */
  invalidateDetail(id: ResourceId): void {
    const next = new Map<ResourceId, ResourceDetail>(this.detail$.value);
    next.delete(id);
    this.detail$.next(next);
    this.fetchDetail(id);
  }

  /** Remove all list caches (triggers re-fetch on next subscribe) */
  invalidateLists(): void {
    this.list$.next(new Map<string, ResourceListResponse>());
  }

  private async fetchDetail(id: ResourceId): Promise<void> {
    if (this.fetchingDetail.has(id)) return;
    this.fetchingDetail.add(id);
    try {
      const resource = await this.http.browseResource(id, { auth: this.getToken() });
      const next = new Map<ResourceId, ResourceDetail>(this.detail$.value);
      next.set(id, resource);
      this.detail$.next(next);
    } catch {
      // Leave cache empty — subscribers see undefined
    } finally {
      this.fetchingDetail.delete(id);
    }
  }

  private async fetchList(key: string, options?: { limit?: number; archived?: boolean }): Promise<void> {
    if (this.fetchingList.has(key)) return;
    this.fetchingList.add(key);
    try {
      const result = await this.http.browseResources(options?.limit, options?.archived, undefined, { auth: this.getToken() });
      const next = new Map<string, ResourceListResponse>(this.list$.value);
      next.set(key, result);
      this.list$.next(next);
    } catch {
      // Leave cache empty
    } finally {
      this.fetchingList.delete(key);
    }
  }
}
