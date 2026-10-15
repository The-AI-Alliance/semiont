import { BehaviorSubject, type Subscription } from 'rxjs';
import type { SemiontClient } from '../../client';
import { watched, type AnnotationId, type GatheredContext, type ResourceId, type StateUnit, type Watched } from '@semiont/core';
import type { GatherNamespace } from '../../namespaces/types';

/** The options `client.gather.resource` takes — one shape, referenced not duplicated. */
export type ResourceGatherOptions = Parameters<GatherNamespace['resource']>[1];

export interface GatherStateUnit extends StateUnit {
  context$: Watched<GatheredContext | null>;
  loading$: Watched<boolean>;
  error$: Watched<Error | null>;
  annotationId$: Watched<AnnotationId | null>;
  /**
   * Resource-gather state: SEPARATE slots from the annotation trio above —
   * the two gathers can be live at once (wizard closed mid-load, Generate
   * open), and one BehaviorSubject cannot represent both. One fact per
   * observable.
   */
  resourceContext$: Watched<GatheredContext | null>;
  resourceLoading$: Watched<boolean>;
  resourceError$: Watched<Error | null>;
  /**
   * Gather a resource-focus context. A METHOD, not a bus channel: the
   * annotation path's channel exists because a far-away component triggers
   * it; this path's only trigger holds the unit already, and a channel is
   * added when a remote trigger exists, not before.
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
  // A completed BehaviorSubject still takes a value from `next`, which its
  // `getValue` then gives: once disposed, nothing here may set one. And
  // `gather.resource` is a Promise, not a stream, so a resolution arriving
  // after dispose is dropped here (A5b).
  let disposed = false;

  const gatherResource = (rid: ResourceId, options?: ResourceGatherOptions): void => {
    if (disposed) return;
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

  subs.push(client.bus.on('gather:requested').subscribe((event) => {
    loading$.next(true);
    error$.next(null);
    context$.next(null);
    annotationId$.next(event.annotationId);

    const gatherSub = client.gather.annotation(
      resourceId,
      event.annotationId,
      { contextWindow: event.options?.contextWindow ?? 2000 },
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
    context$: watched(context$),
    loading$: watched(loading$),
    error$: watched(error$),
    annotationId$: watched(annotationId$),
    resourceContext$: watched(resourceContext$),
    resourceLoading$: watched(resourceLoading$),
    resourceError$: watched(resourceError$),
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
