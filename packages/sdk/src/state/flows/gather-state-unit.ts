import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import { timeout } from 'rxjs/operators';
import type { GatheredContext, ResourceId, AnnotationId } from '@semiont/core';
import { annotationId as makeAnnotationId } from '@semiont/core';
import type { SemiontClient } from '../../client';
import type { StateUnit } from '@semiont/core';
import type { GatherNamespace } from '../../namespaces/types';

/** The options `client.gather.resource` takes — one shape, referenced not duplicated. */
export type ResourceGatherOptions = Parameters<GatherNamespace['resource']>[1];

export interface GatherStateUnit extends StateUnit {
  context$: Observable<GatheredContext | null>;
  loading$: Observable<boolean>;
  error$: Observable<Error | null>;
  annotationId$: Observable<AnnotationId | null>;
  /**
   * Resource-gather state (FLOW-LIFECYCLE-CONVERGENCE D2/D2a): SEPARATE
   * slots from the annotation trio above — the two gathers can be live at
   * once (wizard closed mid-load, Generate open), and one BehaviorSubject
   * cannot represent both. One fact per observable.
   */
  resourceContext$: Observable<GatheredContext | null>;
  resourceLoading$: Observable<boolean>;
  resourceError$: Observable<Error | null>;
  /**
   * Gather a resource-focus context. A METHOD, not a bus channel: the
   * annotation path's channel exists because a far-away component triggers
   * it; this path's only trigger holds the unit already (D2 —
   * ask-what-does-the-SDK-need).
   */
  gatherResource(resourceId: ResourceId, options?: ResourceGatherOptions): void;
}

export function createGatherStateUnit(
  client: SemiontClient,
  resourceId: ResourceId,
): GatherStateUnit {
  const subs: Subscription[] = [];
  const context$ = new BehaviorSubject<GatheredContext | null>(null);
  const loading$ = new BehaviorSubject<boolean>(false);
  const error$ = new BehaviorSubject<Error | null>(null);
  const annotationId$ = new BehaviorSubject<AnnotationId | null>(null);
  const resourceContext$ = new BehaviorSubject<GatheredContext | null>(null);
  const resourceLoading$ = new BehaviorSubject<boolean>(false);
  const resourceError$ = new BehaviorSubject<Error | null>(null);
  // `gather.resource` is a Promise, not a stream — a resolution arriving
  // after dispose must be inert (A5b), and a completed BehaviorSubject's
  // `next` is technically a no-op but the flag states the intent.
  let disposed = false;

  const gatherResource = (rid: ResourceId, options?: ResourceGatherOptions): void => {
    resourceLoading$.next(true);
    resourceError$.next(null);
    resourceContext$.next(null);
    client.gather.resource(rid, options)
      .then((ctx) => {
        if (disposed) return;
        resourceContext$.next(ctx);
        resourceLoading$.next(false);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        resourceError$.next(err instanceof Error ? err : new Error(String(err)));
        resourceLoading$.next(false);
      });
  };

  subs.push(client.bus.get('gather:requested').subscribe((event) => {
    loading$.next(true);
    error$.next(null);
    context$.next(null);
    annotationId$.next(makeAnnotationId(event.annotationId));

    const gatherSub = client.gather.annotation(
      resourceId,
      makeAnnotationId(event.annotationId),
      { contextWindow: event.options?.contextWindow ?? 2000 },
    ).pipe(
      timeout(60_000),
    ).subscribe({
      next: (progress) => {
        if ('response' in progress && progress.response) {
          context$.next(
            (progress as { response: GatheredContext }).response ?? null,
          );
          loading$.next(false);
        }
      },
      error: (err) => {
        error$.next(err instanceof Error ? err : new Error(String(err)));
        loading$.next(false);
      },
      complete: () => {
        loading$.next(false);
      },
    });
    subs.push(gatherSub);
  }));

  return {
    context$: context$.asObservable(),
    loading$: loading$.asObservable(),
    error$: error$.asObservable(),
    annotationId$: annotationId$.asObservable(),
    resourceContext$: resourceContext$.asObservable(),
    resourceLoading$: resourceLoading$.asObservable(),
    resourceError$: resourceError$.asObservable(),
    gatherResource,
    dispose() {
      disposed = true;
      subs.forEach(s => s.unsubscribe());
      context$.complete();
      loading$.complete();
      error$.complete();
      annotationId$.complete();
      resourceContext$.complete();
      resourceLoading$.complete();
      resourceError$.complete();
    },
  };
}
