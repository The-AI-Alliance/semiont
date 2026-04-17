import { Observable, merge } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import type {
  ResourceId,
  AnnotationId,
  Motivation,
  AccessToken,
  EventBus,
} from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { ActorVM } from '../view-models/domain/actor-vm';
import { busRequest } from '../bus-request';
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
    private readonly actor: ActorVM,
  ) {}

  async annotation(resourceId: ResourceId, input: CreateAnnotationInput): Promise<{ annotationId: string }> {
    return busRequest<{ annotationId: string }>(
      this.actor,
      'mark:create-request',
      { resourceId, request: input as unknown as Record<string, unknown> },
      'mark:create-ok',
      'mark:create-failed',
    );
  }

  async delete(resourceId: ResourceId, annotationId: AnnotationId): Promise<void> {
    await this.actor.emit('mark:delete', { annotationId, resourceId });
  }

  async entityType(type: string): Promise<void> {
    await this.actor.emit('mark:add-entity-type', { tag: type });
  }

  async entityTypes(types: string[]): Promise<void> {
    for (const tag of types) {
      await this.actor.emit('mark:add-entity-type', { tag });
    }
  }

  async updateResource(resourceId: ResourceId, data: UpdateResourceInput): Promise<void> {
    return this.http.updateResource(resourceId, data, { auth: this.getToken() });
  }

  async archive(resourceId: ResourceId): Promise<void> {
    await this.actor.emit('mark:archive', { resourceId });
  }

  async unarchive(resourceId: ResourceId): Promise<void> {
    await this.actor.emit('mark:unarchive', { resourceId });
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
            busRequest<{ status: string; result?: unknown; error?: string }>(
              this.actor, 'job:status-requested', { jobId }, 'job:status-result', 'job:status-failed',
            ).then((status) => {
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
    _auth: AccessToken | undefined,
  ): Promise<{ jobId: string }> {
    const jobTypeMap: Record<string, string> = {
      tagging: 'tag-annotation',
      linking: 'reference-annotation',
      highlighting: 'highlight-annotation',
      assessing: 'assessment-annotation',
      commenting: 'comment-annotation',
    };
    const jobType = jobTypeMap[motivation];
    if (!jobType) throw new Error(`Unsupported motivation: ${motivation}`);

    if (motivation === 'tagging') {
      if (!options.schemaId || !options.categories?.length) throw new Error('Tag assist requires schemaId and categories');
    } else if (motivation === 'linking') {
      if (!options.entityTypes?.length) throw new Error('Reference assist requires entityTypes');
    }

    const params: Record<string, unknown> = {};
    if (options.entityTypes) params.entityTypes = options.entityTypes;
    if (options.includeDescriptiveReferences !== undefined) params.includeDescriptiveReferences = options.includeDescriptiveReferences;
    if (options.instructions !== undefined) params.instructions = options.instructions;
    if (options.density !== undefined) params.density = options.density;
    if (options.tone !== undefined) params.tone = options.tone;
    if (options.language !== undefined) params.language = options.language;
    if (options.schemaId !== undefined) params.schemaId = options.schemaId;
    if (options.categories !== undefined) params.categories = options.categories;

    return busRequest<{ jobId: string }>(
      this.actor,
      'job:create',
      { jobType, resourceId, params },
      'job:created',
      'job:create-failed',
    );
  }
}
