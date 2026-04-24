import { Observable, merge } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import type {
  ResourceId,
  AnnotationId,
  EventBus,
  components,
} from '@semiont/core';

// YieldProgress is the per-yield view of a job's JobProgress payload;
// we don't need a separate schema type now that job:* carries both.
type YieldProgress = components['schemas']['JobProgress'];
import type { ITransport, IContentTransport } from '../transport/types';
import { busRequest } from '../bus-request';
import type {
  YieldNamespace as IYieldNamespace,
  CreateResourceInput,
  GenerationOptions,
  CreateFromTokenOptions,
} from './types';

import type { ResourceDescriptor } from '@semiont/core';
type GetResourceByTokenResponse = components['schemas']['GetResourceByTokenResponse'];

export class YieldNamespace implements IYieldNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
    private readonly content: IContentTransport,
  ) {}

  async resource(data: CreateResourceInput): Promise<{ resourceId: string }> {
    const result = await this.content.putBinary({
      name: data.name,
      file: data.file,
      format: data.format,
      storageUri: data.storageUri,
      ...(data.entityTypes ? { entityTypes: data.entityTypes } : {}),
      ...(data.language ? { language: data.language } : {}),
      ...(data.creationMethod ? { creationMethod: data.creationMethod } : {}),
      ...(data.sourceAnnotationId ? { sourceAnnotationId: data.sourceAnnotationId } : {}),
      ...(data.sourceResourceId ? { sourceResourceId: data.sourceResourceId } : {}),
      ...(data.generationPrompt ? { generationPrompt: data.generationPrompt } : {}),
      ...(data.generator ? { generator: data.generator } : {}),
      ...(data.isDraft !== undefined ? { isDraft: data.isDraft } : {}),
    });
    return { resourceId: result.resourceId as string };
  }

  fromAnnotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    options: GenerationOptions,
  ): Observable<YieldProgress> {
    return new Observable((subscriber) => {
      let done = false;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      let pollInterval: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        done = true;
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
      };

      const resetPollTimer = (jid: string) => {
        if (pollTimer) clearTimeout(pollTimer);
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        pollTimer = setTimeout(() => {
          if (done) return;
          pollInterval = setInterval(() => {
            if (done) return;
            busRequest<{ status: string; result?: Record<string, unknown>; error?: string }>(
              this.transport, 'job:status-requested', { jobId: jid }, 'job:status-result', 'job:status-failed',
            ).then((status) => {
                if (done) return;
                if (status.status === 'complete') {
                  cleanup();
                  subscriber.next({ stage: 'complete', percentage: 100, message: 'Generation complete' });
                  subscriber.complete();
                } else if (status.status === 'failed') {
                  cleanup();
                  subscriber.error(new Error(status.error ?? 'Generation failed'));
                }
              })
              .catch(() => {});
          }, 5_000);
        }, 10_000);
      };

      // Subscribe to the unified job lifecycle filtered by this job's
      // jobId (assigned by `job:create` below). Auto-bind (resolving the
      // source reference to the generated resource) is handled in
      // Stower's `yield:create` handler when `generatedFrom.annotationId`
      // is present — not here, because the generated resource id is
      // assigned by Stower, not by the worker.
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
          subscriber.next(e.progress as YieldProgress);
          if (activeJobId) resetPollTimer(activeJobId);
        });

      const completeSub = complete$.subscribe(() => {
        cleanup();
        subscriber.complete();
      });

      const failSub = fail$.subscribe((e) => {
        cleanup();
        subscriber.error(new Error(e.error));
      });

      busRequest<{ jobId: string }>(
        this.transport,
        'job:create',
        {
          jobType: 'generation',
          resourceId,
          params: {
            referenceId: annotationId,
            title: options.title,
            prompt: options.prompt,
            language: options.language,
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            storageUri: options.storageUri,
            context: options.context as unknown as Record<string, unknown>,
          },
        },
        'job:created',
        'job:create-failed',
      ).then(({ jobId }) => {
        if (jobId && !done) {
          activeJobId = jobId;
          resetPollTimer(jobId);
        }
      }).catch((error) => {
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

  async cloneToken(resourceId: ResourceId): Promise<{ token: string; expiresAt: string }> {
    return busRequest<{ token: string; expiresAt: string }>(
      this.transport,
      'yield:clone-token-requested',
      { resourceId },
      'yield:clone-token-generated',
      'yield:clone-token-failed',
    );
  }

  async fromToken(token: string): Promise<ResourceDescriptor> {
    const result = await busRequest<GetResourceByTokenResponse>(
      this.transport,
      'yield:clone-resource-requested',
      { token },
      'yield:clone-resource-result',
      'yield:clone-resource-failed',
    );
    return result.sourceResource as ResourceDescriptor;
  }

  async createFromToken(options: CreateFromTokenOptions): Promise<{ resourceId: string }> {
    return busRequest<{ resourceId: string }>(
      this.transport,
      'yield:clone-create',
      options as unknown as Record<string, unknown>,
      'yield:clone-created',
      'yield:clone-create-failed',
    );
  }

  clone(): void {
    this.bus.get('yield:clone').next(undefined);
  }
}
