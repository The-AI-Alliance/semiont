import { filter, map } from 'rxjs/operators';
import type { AnnotationId, CacheQuery, ResourceId, EventBus, GatheredContext } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import { CacheObservable, StreamObservable } from '../awaitable';
import { busRequest, uuidV4 } from '@semiont/core';
import { createCache, type Cache } from '../cache';
import { CacheRefresher, ScopedSources } from '../cache-refresh';
import type { GatherNamespace as IGatherNamespace, GatherAnnotationComplete, ReferencedByEntry } from './types';

/**
 * The live queries of specs/src/client/refresh.json this namespace answers.
 * `client.ts` holds the namespaces to answering every one between them.
 */
export const GATHER_QUERIES = ['referencedBy'] as const satisfies readonly CacheQuery[];
type GatherQuery = (typeof GATHER_QUERIES)[number];

export class GatherNamespace implements IGatherNamespace {
  /** In memory only: an answer of the graph, asked again on each session. */
  private readonly referencedByCache: Cache<ResourceId, ReferencedByEntry[]>;
  private readonly scoped: ScopedSources;
  private readonly refresher: CacheRefresher<GatherQuery>;

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
    this.scoped = new ScopedSources(this.transport);

    this.referencedByCache = createCache<ResourceId, ReferencedByEntry[]>(async (resourceId) => {
      const result = await busRequest(
        this.transport,
        'gather:referenced-by-requested',
        { resourceId },
        options?.busTimeoutMs,
      );
      return result.referencedBy;
    });

    this.refresher = new CacheRefresher<GatherQuery>(this.transport, this.bus, {
      referencedBy: {
        refetch: (subject, reach) => {
          const resources = reach === 'held' ? this.referencedByCache.keys() : subject.resource ? [subject.resource] : [];
          for (const rId of resources) {
            this.refresher.held(this.referencedByCache, rId, `referenced-by/${rId}`, () => this.invalidateReferencedBy(rId));
          }
        },
      },
    }, options?.invalidationWindowMs);
  }

  /**
   * The annotations elsewhere that refer to a resource — a live query, kept
   * per resource. Subscribing acquires the resource's scope.
   */
  referencedBy(resourceId: ResourceId): CacheObservable<ReferencedByEntry[]> {
    return CacheObservable.from(
      this.scoped.of(resourceId, this.referencedByCache.observe(resourceId)),
      () => this.referencedByCache.fetch(resourceId),
    );
  }

  /** A direct caller says the key is out of date: asked again at once, whatever it holds (B8). */
  invalidateReferencedBy(resourceId: ResourceId): void {
    this.referencedByCache.invalidate(resourceId);
  }

  /** B16: detach from the bus and dispose the cache this namespace built. Idempotent. */
  dispose(): void {
    this.refresher.dispose();
    this.referencedByCache.dispose();
  }

  annotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    options?: { contextWindow?: number },
  ): StreamObservable<GatherAnnotationComplete> {
    return new StreamObservable<GatherAnnotationComplete>((subscriber) => {
      const correlationId = uuidV4();

      const complete$ = this.bus.frames('gather:complete').pipe(
        filter((frame) => frame.correlationId === correlationId),
        map((frame) => frame.payload),
      );
      const failed$ = this.bus.frames('gather:failed').pipe(
        filter((frame) => frame.correlationId === correlationId),
        map((frame) => frame.payload),
      );

      const completeSub = complete$.subscribe((e) => {
        subscriber.next(e);
        subscriber.complete();
      });

      const failedSub = failed$.subscribe((e) => {
        subscriber.error(new Error(e.message));
      });

      this.transport.emit('gather:requested', {
        annotationId,
        resourceId,
        options: { contextWindow: options?.contextWindow ?? 2000 },
      }, { correlationId }).catch((error) => {
        // Don't propagate if a result or failure event already closed the
        // subscriber, or if the consumer disposed mid-flight. Otherwise
        // RxJS hosts the error as an uncaught exception.
        if (subscriber.closed) return;
        subscriber.error(error);
      });

      return () => {
        completeSub.unsubscribe();
        failedSub.unsubscribe();
      };
    });
  }

  /**
   * Gather whole-resource LLM context — a request/reply over
   * `gather:resource-requested` → `gather:resource-complete`/`-failed`, shaped
   * as a `Promise` rather than the `StreamObservable` `annotation()` returns. Resolves to the unified `GatheredContext` (focus.kind:
   * 'resource') the gateway assembled — the resource focus plus the shared
   * knowledge graph; rejects with a `BusRequestError` on failure. Defaults mirror
   * the CLI `gather` command (depth 2, maxResources 10, content in, summary out).
   */
  resource(
    resourceId: ResourceId,
    options?: {
      depth?: number;
      maxResources?: number;
      includeContent?: boolean;
      includeSummary?: boolean;
      /** Entity types to exclude from the semantic recall built into the context
       *  (e.g. ['Question'] so prior questions never ground answer generation). */
      excludeEntityTypes?: string[];
    },
  ): Promise<GatheredContext> {
    return busRequest(
      this.transport,
      'gather:resource-requested',
      {
        resourceId,
        options: {
          depth: options?.depth ?? 2,
          maxResources: options?.maxResources ?? 10,
          includeContent: options?.includeContent ?? true,
          includeSummary: options?.includeSummary ?? false,
          ...(options?.excludeEntityTypes?.length ? { excludeEntityTypes: options.excludeEntityTypes } : {}),
        },
      },
    );
  }
}
