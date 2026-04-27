import { merge } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import {
  annotationId as toAnnotationId,
} from '@semiont/core';
import type {
  ResourceId,
  AnnotationId,
  Motivation,
  EventBus,
  components,
} from '@semiont/core';
import type { ITransport } from '@semiont/core';
import { busRequest } from '../bus-request';
import { StreamObservable } from '../awaitable';
import type {
  MarkNamespace as IMarkNamespace,
  CreateAnnotationInput,
  MarkAssistOptions,
  MarkAssistEvent,
} from './types';

export class MarkNamespace implements IMarkNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {}

  async annotation(resourceId: ResourceId, input: CreateAnnotationInput): Promise<{ annotationId: AnnotationId }> {
    const result = await busRequest<{ annotationId: string }>(
      this.transport,
      'mark:create-request',
      { resourceId, request: input },
      'mark:create-ok',
      'mark:create-failed',
    );
    return { annotationId: toAnnotationId(result.annotationId) };
  }

  async delete(resourceId: ResourceId, annotationId: AnnotationId): Promise<void> {
    await this.transport.emit('mark:delete', { annotationId, resourceId });
  }

  async entityType(type: string): Promise<void> {
    await this.transport.emit('mark:add-entity-type', { tag: type });
  }

  async entityTypes(types: string[]): Promise<void> {
    for (const tag of types) {
      await this.transport.emit('mark:add-entity-type', { tag });
    }
  }

  async archive(resourceId: ResourceId): Promise<void> {
    await this.transport.emit('mark:archive', { resourceId });
  }

  async unarchive(resourceId: ResourceId): Promise<void> {
    await this.transport.emit('mark:unarchive', { resourceId });
  }

  assist(resourceId: ResourceId, motivation: Motivation, options: MarkAssistOptions): StreamObservable<MarkAssistEvent> {
    return new StreamObservable<MarkAssistEvent>((subscriber) => {
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
            busRequest<{ status: string; result?: unknown; error?: string; jobType?: string }>(
              this.transport, 'job:status-requested', { jobId }, 'job:status-result', 'job:status-failed',
            ).then((status) => {
                if (done) return;
                if (status.status === 'complete') {
                  cleanup();
                  // Synthesize a `complete` event from polled status.
                  subscriber.next({
                    kind: 'complete',
                    data: {
                      jobId,
                      jobType: (status.jobType ?? 'annotation') as components['schemas']['JobType'],
                      resourceId: resourceId as string,
                      result: status.result as components['schemas']['JobResult'] | undefined,
                    },
                  });
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

      // Subscribe to the unified job lifecycle filtered by the jobId
      // we're about to be assigned. Safe to subscribe before the job
      // exists: early events for an unknown jobId simply never arrive,
      // and the `activeJobId` guard on the filter keeps each Observable
      // isolated to its own job.
      let activeJobId: string | null = null;
      const progress$ = this.bus.get('job:report-progress').pipe(
        filter((e) => e.jobId === activeJobId),
      );
      const complete$ = this.bus.get('job:complete').pipe(
        filter((e) => e.jobId === activeJobId),
      );
      const fail$ = this.bus.get('job:fail').pipe(
        filter((e) => e.jobId === activeJobId),
      );

      const progressSub = progress$
        .pipe(takeUntil(merge(complete$, fail$)))
        .subscribe((e) => {
          if (e.progress) subscriber.next({ kind: 'progress', data: e.progress });
          if (activeJobId) resetPollTimer(activeJobId);
        });

      const completeSub = complete$.subscribe((e) => {
        cleanup();
        subscriber.next({ kind: 'complete', data: e });
        subscriber.complete();
      });

      const failSub = fail$.subscribe((e) => {
        cleanup();
        subscriber.error(new Error(e.error));
      });

      this.dispatchAssist(resourceId, motivation, options)
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
        completeSub.unsubscribe();
        failSub.unsubscribe();
      };
    });
  }

  request(
    selector: components['schemas']['MarkRequestedEvent']['selector'],
    motivation: Motivation,
  ): void {
    // Local emit: mark-vm subscribes via the local bus.
    this.bus.get('mark:requested').next({ selector, motivation });
  }

  requestAssist(motivation: Motivation, options: MarkAssistOptions, correlationId?: string): void {
    this.bus.get('mark:assist-request').next({
      motivation,
      options,
      ...(correlationId ? { correlationId } : {}),
    } as components['schemas']['MarkAssistRequestEvent']);
  }

  submit(input: components['schemas']['MarkSubmitEvent']): void {
    this.bus.get('mark:submit').next(input);
  }

  cancelPending(): void {
    this.bus.get('mark:cancel-pending').next(undefined);
  }

  dismissProgress(): void {
    this.bus.get('mark:progress-dismiss').next(undefined);
  }

  changeSelection(motivation: Motivation | null): void {
    this.bus.get('mark:selection-changed').next({ motivation });
  }

  changeClick(action: string): void {
    this.bus.get('mark:click-changed').next({ action });
  }

  changeShape(shape: string): void {
    this.bus.get('mark:shape-changed').next({ shape });
  }

  toggleMode(): void {
    this.bus.get('mark:mode-toggled').next(undefined);
  }

  private async dispatchAssist(
    resourceId: ResourceId,
    motivation: Motivation,
    options: MarkAssistOptions,
  ): Promise<{ jobId: string }> {
    const jobTypeMap: Record<string, components['schemas']['JobType']> = {
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
      this.transport,
      'job:create',
      { jobType, resourceId, params },
      'job:created',
      'job:create-failed',
    );
  }
}
