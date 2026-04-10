/**
 * YieldNamespace — resource creation
 *
 * resource() is synchronous file upload (Promise).
 * fromAnnotation() is long-running LLM generation (Observable).
 *
 * Backend actor: Stower + generation worker
 * Event prefix: yield:*
 */

import { Observable, merge } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import type {
  ResourceId,
  AnnotationId,
  AccessToken,
  CloneToken,
  YieldProgress,
  EventBus,
  EventMap,
  components,
} from '@semiont/core';
import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type {
  YieldNamespace as IYieldNamespace,
  CreateResourceInput,
  GenerationOptions,
  CreateFromTokenOptions,
} from './types';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type GetResourceByTokenResponse = components['schemas']['GetResourceByTokenResponse'];
type TokenGetter = () => AccessToken | undefined;

export class YieldNamespace implements IYieldNamespace {
  constructor(
    private readonly http: SemiontApiClient,
    private readonly eventBus: EventBus,
    private readonly getToken: TokenGetter,
  ) {}

  async resource(data: CreateResourceInput): Promise<{ resourceId: string }> {
    return this.http.yieldResource(data, { auth: this.getToken() });
  }

  fromAnnotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    options: GenerationOptions,
  ): Observable<YieldProgress> {
    return new Observable((subscriber) => {
      const progress$ = this.eventBus.get('yield:progress').pipe(
        filter((e) => e.referenceId === (annotationId as string)),
      );
      const finished$ = this.eventBus.get('yield:finished').pipe(
        filter((e) => e.referenceId === (annotationId as string)),
      );
      const failed$ = this.eventBus.get('yield:failed').pipe(
        filter((e) => e.referenceId === (annotationId as string)),
      );

      const progressSub = progress$
        .pipe(takeUntil(merge(finished$, failed$)))
        .subscribe((e) => subscriber.next(e));

      const finishedSub = finished$.subscribe((event: EventMap['yield:finished']) => {
        subscriber.next(event);
        subscriber.complete();

        // Auto-link: bind the generated resource back to the reference annotation
        if (event.resourceId && event.referenceId && event.sourceResourceId) {
          this.eventBus.get('bind:update-body').next({
            correlationId: crypto.randomUUID(),
            annotationId: makeAnnotationId(event.referenceId),
            resourceId: makeResourceId(event.sourceResourceId),
            operations: [{ op: 'add', item: { type: 'SpecificResource', source: event.resourceId } }],
          });
        }
      });

      const failedSub = failed$.subscribe((e) => {
        subscriber.error(new Error(e.error ?? e.message ?? 'Generation failed'));
      });

      // Fire the HTTP POST
      this.http.yieldResourceFromAnnotation(
        resourceId,
        annotationId,
        options,
        { auth: this.getToken() },
      ).catch((error) => {
        subscriber.error(error);
      });

      return () => {
        progressSub.unsubscribe();
        finishedSub.unsubscribe();
        failedSub.unsubscribe();
      };
    });
  }

  async cloneToken(resourceId: ResourceId): Promise<{ token: string; expiresAt: string }> {
    const result = await this.http.generateCloneToken(resourceId, { auth: this.getToken() });
    return result as unknown as { token: string; expiresAt: string };
  }

  async fromToken(token: string): Promise<ResourceDescriptor> {
    const result = await this.http.getResourceByToken(token as CloneToken, { auth: this.getToken() });
    return (result as unknown as GetResourceByTokenResponse).sourceResource;
  }

  async createFromToken(options: CreateFromTokenOptions): Promise<{ resourceId: string }> {
    return this.http.createResourceFromToken(options, { auth: this.getToken() });
  }
}
