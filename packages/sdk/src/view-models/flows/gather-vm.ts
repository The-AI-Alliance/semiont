import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import { timeout } from 'rxjs/operators';
import type { GatheredContext, ResourceId, AnnotationId } from '@semiont/core';
import { annotationId as makeAnnotationId } from '@semiont/core';
import type { SemiontClient } from '../../client';
import type { ViewModel } from '../lib/view-model';

export interface GatherVM extends ViewModel {
  context$: Observable<GatheredContext | null>;
  loading$: Observable<boolean>;
  error$: Observable<Error | null>;
  annotationId$: Observable<AnnotationId | null>;
}

export function createGatherVM(
  client: SemiontClient,
  resourceId: ResourceId,
): GatherVM {
  const subs: Subscription[] = [];
  const context$ = new BehaviorSubject<GatheredContext | null>(null);
  const loading$ = new BehaviorSubject<boolean>(false);
  const error$ = new BehaviorSubject<Error | null>(null);
  const annotationId$ = new BehaviorSubject<AnnotationId | null>(null);

  subs.push(client.bus.get('gather:requested').subscribe((event) => {
    loading$.next(true);
    error$.next(null);
    context$.next(null);
    annotationId$.next(makeAnnotationId(event.annotationId));

    const gatherSub = client.gather.annotation(
      makeAnnotationId(event.annotationId),
      resourceId,
      { contextWindow: event.options?.contextWindow ?? 2000 },
    ).pipe(
      timeout(60_000),
    ).subscribe({
      next: (progress) => {
        if ('response' in progress && progress.response) {
          context$.next(
            (progress as { response: { context: GatheredContext } }).response.context ?? null,
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
    dispose() {
      subs.forEach(s => s.unsubscribe());
      context$.complete();
      loading$.complete();
      error$.complete();
      annotationId$.complete();
    },
  };
}
