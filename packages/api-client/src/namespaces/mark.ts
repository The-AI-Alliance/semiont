/**
 * MarkNamespace — annotation CRUD, entity types, AI assist
 *
 * Commands return Promises that resolve on HTTP acceptance.
 * Results appear on browse Observables via events-stream.
 * assist() returns an Observable for long-running progress.
 *
 * Backend actor: Stower
 * Event prefix: mark:*
 */

import { Observable, merge } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import { jobId as makeJobId } from '@semiont/core';
import type {
  ResourceId,
  AnnotationId,
  Motivation,
  AccessToken,
  EntityType,
  EventBus,
} from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type {
  MarkNamespace as IMarkNamespace,
  CreateAnnotationInput,
  MarkAssistOptions,
  MarkAssistProgress,
} from './types';
import type { UpdateResourceInput } from '@semiont/core';

type TokenGetter = () => AccessToken | undefined;

export class MarkNamespace implements IMarkNamespace {
  constructor(
    private readonly http: SemiontApiClient,
    private readonly eventBus: EventBus,
    private readonly getToken: TokenGetter,
  ) {}

  async annotation(resourceId: ResourceId, input: CreateAnnotationInput): Promise<{ annotationId: string }> {
    return this.http.markAnnotation(resourceId, input, { auth: this.getToken() });
  }

  async delete(resourceId: ResourceId, annotationId: AnnotationId): Promise<void> {
    return this.http.deleteAnnotation(resourceId, annotationId, { auth: this.getToken() });
  }

  async entityType(type: string): Promise<void> {
    return this.http.addEntityType(type as EntityType, { auth: this.getToken() });
  }

  async entityTypes(types: string[]): Promise<void> {
    return this.http.addEntityTypesBulk(types as EntityType[], { auth: this.getToken() });
  }

  async updateResource(resourceId: ResourceId, data: UpdateResourceInput): Promise<void> {
    return this.http.updateResource(resourceId, data, { auth: this.getToken() });
  }

  async archive(resourceId: ResourceId): Promise<void> {
    return this.http.updateResource(resourceId, { archived: true }, { auth: this.getToken() });
  }

  async unarchive(resourceId: ResourceId): Promise<void> {
    return this.http.updateResource(resourceId, { archived: false }, { auth: this.getToken() });
  }

  assist(resourceId: ResourceId, motivation: Motivation, options: MarkAssistOptions): Observable<MarkAssistProgress> {
    return new Observable((subscriber) => {
      let done = false;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      let pollInterval: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        done = true;
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
      };

      const resetPollTimer = (jobId: string) => {
        if (pollTimer) clearTimeout(pollTimer);
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        pollTimer = setTimeout(() => {
          if (done) return;
          pollInterval = setInterval(() => {
            if (done) return;
            this.http.getJobStatus(makeJobId(jobId), { auth: this.getToken() })
              .then((status) => {
                if (done) return;
                if (status.status === 'complete') {
                  cleanup();
                  subscriber.next({ motivation, resourceId: resourceId as string, progress: status.result } as unknown as MarkAssistProgress);
                  subscriber.complete();
                } else if (status.status === 'failed') {
                  cleanup();
                  subscriber.error(new Error(status.error ?? 'Job failed'));
                }
              })
              .catch(() => {});
          }, 5_000);
        }, 10_000);
      };

      const progress$ = this.eventBus.get('mark:progress').pipe(
        filter((e) => e.resourceId === (resourceId as string)),
      );
      const finished$ = this.eventBus.get('mark:assist-finished').pipe(
        filter((e) => e.resourceId === (resourceId as string) && e.motivation === motivation),
      );
      const failed$ = this.eventBus.get('mark:assist-failed').pipe(
        filter((e) => e.resourceId === (resourceId as string)),
      );

      let activeJobId: string | null = null;

      const progressSub = progress$
        .pipe(takeUntil(merge(finished$, failed$)))
        .subscribe((e) => {
          subscriber.next(e as MarkAssistProgress);
          if (activeJobId) resetPollTimer(activeJobId);
        });

      const finishedSub = finished$.subscribe((e) => {
        cleanup();
        subscriber.next(e as MarkAssistProgress);
        subscriber.complete();
      });

      const failedSub = failed$.subscribe((e) => {
        cleanup();
        subscriber.error(new Error(e.message));
      });

      const auth = this.getToken();
      this.dispatchAssist(resourceId, motivation, options, auth)
        .then(({ jobId }) => {
          if (jobId && !done) {
            activeJobId = jobId;
            resetPollTimer(jobId);
          }
        })
        .catch((error) => {
          cleanup();
          subscriber.error(error);
        });

      return () => {
        cleanup();
        progressSub.unsubscribe();
        finishedSub.unsubscribe();
        failedSub.unsubscribe();
      };
    });
  }

  private async dispatchAssist(
    resourceId: ResourceId,
    motivation: Motivation,
    options: MarkAssistOptions,
    auth: AccessToken | undefined,
  ): Promise<{ jobId: string }> {
    if (motivation === 'tagging') {
      const { schemaId, categories } = options;
      if (!schemaId || !categories?.length) throw new Error('Tag assist requires schemaId and categories');
      return this.http.annotateTags(resourceId, { schemaId, categories }, { auth });
    } else if (motivation === 'linking') {
      const { entityTypes, includeDescriptiveReferences } = options;
      if (!entityTypes?.length) throw new Error('Reference assist requires entityTypes');
      return this.http.annotateReferences(resourceId, {
        entityTypes: entityTypes as string[],
        includeDescriptiveReferences: includeDescriptiveReferences ?? false,
      }, { auth });
    } else if (motivation === 'highlighting') {
      return this.http.annotateHighlights(resourceId, {
        instructions: options.instructions,
        density: options.density,
      }, { auth });
    } else if (motivation === 'assessing') {
      return this.http.annotateAssessments(resourceId, {
        instructions: options.instructions,
        tone: options.tone,
        density: options.density,
        language: options.language,
      }, { auth });
    } else if (motivation === 'commenting') {
      return this.http.annotateComments(resourceId, {
        instructions: options.instructions,
        tone: options.tone,
        density: options.density,
        language: options.language,
      }, { auth });
    }
    throw new Error(`Unsupported motivation: ${motivation}`);
  }
}
