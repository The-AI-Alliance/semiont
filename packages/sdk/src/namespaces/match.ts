import { filter, map} from 'rxjs/operators';
import type { AnnotationId, CacheQuery, ResourceDescriptor, ResourceId, GatheredContext, EventBus, components } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import { busRequest, uuidV4 } from '@semiont/core';
import { CacheObservable, StreamObservable } from '../awaitable';
import { createCache, type Cache } from '../cache';
import { CacheRefresher } from '../cache-refresh';
import type { MatchNamespace as IMatchNamespace, MatchSearchProgress, MatchedResources, ResourceSearchFilters } from './types';

/**
 * The live queries of specs/src/client/refresh.json this namespace answers.
 * `client.ts` holds the namespaces to answering every one between them.
 */
export const MATCH_QUERIES = ['matchedResources'] as const satisfies readonly CacheQuery[];
type MatchQuery = (typeof MATCH_QUERIES)[number];

export class MatchNamespace implements IMatchNamespace {
  /** One per search and set of filters asked for. In memory only. */
  private readonly resourcesCache: Cache<string, MatchedResources>;
  /** What each key asks, so a refetch can ask it again. */
  private readonly resourcesAsked = new Map<string, { search: string; filters: ResourceSearchFilters }>();
  private readonly refresher: CacheRefresher<MatchQuery>;

  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
    options?: {
      /** Timeout of the requests the live query issues; absent, `busRequest`'s own. */
      busTimeoutMs?: number;
      /** B19's window; absent, `invalidationWindowMs` of specs/src/client/timing.json. */
      invalidationWindowMs?: number;
    },
  ) {
    this.resourcesCache = createCache<string, MatchedResources>(async (key) => {
      const asked = this.resourcesAsked.get(key);
      if (!asked) throw new Error(`Cannot search resources for ${key}: nothing asked it`);
      const result = await busRequest(
        this.transport,
        'match:resources-requested',
        {
          search: asked.search,
          archived: asked.filters.archived,
          entityType: asked.filters.entityType,
          limit: asked.filters.limit ?? 100,
          offset: 0,
        },
        options?.busTimeoutMs,
      );
      // Brand the wire type (unbranded @id: string) to the SDK's ResourceDescriptor
      // (@id: ResourceId) at the boundary. The whole envelope is cached, not
      // just the page: `matchKind` and the list it labels are one value.
      return { ...result, resources: result.resources as ResourceDescriptor[] };
    });

    this.refresher = new CacheRefresher<MatchQuery>(this.transport, this.bus, {
      // Its keys are the searches the cache knows: `invalidateAll` reaches no other.
      matchedResources: { refetch: () => this.refresher.windowed('matched-resources', () => this.invalidateResources()) },
    }, options?.invalidationWindowMs);
  }

  /**
   * The resources a text search finds — a live query, kept per search and
   * set of filters. The Librarian matches the text lexically and, when
   * nothing matches, by meaning; `matchKind` says which answer this is.
   */
  resources(search: string, filters?: ResourceSearchFilters): CacheObservable<MatchedResources> {
    const key = JSON.stringify({ search, ...filters });
    this.resourcesAsked.set(key, { search, filters: filters ?? {} });
    return CacheObservable.from(this.resourcesCache.observe(key), () => this.resourcesCache.fetch(key));
  }

  /** A direct caller says every held search is out of date: each is asked again at once (B8). */
  invalidateResources(): void {
    this.resourcesCache.invalidateAll();
  }

  /** B16: detach from the bus and dispose the cache this namespace built. Idempotent. */
  dispose(): void {
    this.refresher.dispose();
    this.resourcesCache.dispose();
    this.resourcesAsked.clear();
  }

  requestSearch(input: components['schemas']['MatchSearchRequest'], correlationId: string): void {
    // Local emit: match-state-unit subscribes via the local bus. The key is
    // the caller's to mint and rides the envelope, never the request body.
    this.bus.emit('match:search-requested', input, { correlationId });
  }

  search(
    resourceId: ResourceId,
    referenceId: AnnotationId,
    context: GatheredContext,
    options?: { limit?: number; useSemanticScoring?: boolean },
  ): StreamObservable<MatchSearchProgress> {
    return new StreamObservable<MatchSearchProgress>((subscriber) => {
      const correlationId = uuidV4();

      const result$ = this.bus.frames('match:search-results').pipe(
        filter((frame) => frame.correlationId === correlationId),
        map((frame) => frame.payload),
      );
      const failed$ = this.bus.frames('match:search-failed').pipe(
        filter((frame) => frame.correlationId === correlationId),
        map((frame) => frame.payload),
      );

      const resultSub = result$.subscribe((e) => {
        subscriber.next(e as MatchSearchProgress);
        subscriber.complete();
      });

      const failedSub = failed$.subscribe((e) => {
        subscriber.error(new Error(e.error));
      });

      this.transport.emit('match:search-requested', { resourceId,
        referenceId,
        context,
        limit: options?.limit ?? 10,
        useSemanticScoring: options?.useSemanticScoring ?? true, }, { correlationId }).catch((error) => {
        // Don't propagate if a result or failure event already closed the
        // subscriber, or if the consumer disposed mid-flight. Otherwise
        // RxJS hosts the error as an uncaught exception.
        if (subscriber.closed) return;
        subscriber.error(error);
      });

      return () => {
        resultSub.unsubscribe();
        failedSub.unsubscribe();
      };
    });
  }
}
