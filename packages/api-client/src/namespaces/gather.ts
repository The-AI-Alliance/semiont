/**
 * GatherNamespace — context assembly
 *
 * Long-running (LLM calls + graph traversal). Returns Observables
 * that emit progress then the gathered context.
 *
 * Backend actor: Gatherer
 * Event prefix: gather:*
 */

import { Observable, merge } from 'rxjs';
import { filter, map, takeUntil } from 'rxjs/operators';
import type { AnnotationId, ResourceId, AccessToken, EventBus } from '@semiont/core';
import { annotationId as makeAnnotationId } from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { GatherNamespace as IGatherNamespace, GatherAnnotationProgress } from './types';

type TokenGetter = () => AccessToken | undefined;

export class GatherNamespace implements IGatherNamespace {
  constructor(
    private readonly http: SemiontApiClient,
    private readonly eventBus: EventBus,
    private readonly getToken: TokenGetter,
  ) {}

  annotation(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    options?: { contextWindow?: number },
  ): Observable<GatherAnnotationProgress> {
    return new Observable((subscriber) => {
      const correlationId = crypto.randomUUID();

      // Subscribe to progress + completion events filtered by correlationId
      const complete$ = this.eventBus.get('gather:complete').pipe(
        filter((e) => e.correlationId === correlationId),
      );
      const failed$ = this.eventBus.get('gather:failed').pipe(
        filter((e) => e.correlationId === correlationId),
      );

      const sub = merge(
        this.eventBus.get('gather:annotation-progress').pipe(
          // Progress events don't carry correlationId, so match by annotationId
          filter((e) => (e as { annotationId?: string }).annotationId === (annotationId as string)),
          map((e) => e as GatherAnnotationProgress),
        ),
        complete$.pipe(map((e) => e as GatherAnnotationProgress)),
      )
        .pipe(takeUntil(merge(complete$, failed$)))
        .subscribe({
          next: (v) => subscriber.next(v),
          error: (e) => subscriber.error(e),
        });

      // On complete, emit final value and complete the Observable
      const completeSub = complete$.subscribe((e) => {
        subscriber.next(e as GatherAnnotationProgress);
        subscriber.complete();
      });

      const failedSub = failed$.subscribe((e) => {
        subscriber.error(new Error(e.message));
      });

      // Fire the HTTP POST
      this.http.gatherAnnotationContext(
        resourceId,
        makeAnnotationId(annotationId as string),
        { correlationId, contextWindow: options?.contextWindow ?? 2000 },
        { auth: this.getToken() },
      ).catch((error) => {
        subscriber.error(error);
      });

      return () => {
        sub.unsubscribe();
        completeSub.unsubscribe();
        failedSub.unsubscribe();
      };
    });
  }

  resource(
    _resourceId: ResourceId,
    _options?: { contextWindow?: number },
  ): Observable<GatherAnnotationProgress> {
    throw new Error('Not implemented: gather.resource() — no backend route yet');
  }
}
