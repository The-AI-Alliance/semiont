import { Observable, merge } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import type {
  ResourceId,
  AnnotationId,
  AccessToken,
  EventBus,
  components,
} from '@semiont/core';

// YieldProgress is the per-yield view of a job's JobProgress payload;
// we don't need a separate schema type now that job:* carries both.
type YieldProgress = components['schemas']['JobProgress'];
import type { SemiontApiClient } from '../client';
import type { ActorVM } from '../view-models/domain/actor-vm';
import { busRequest } from '../bus-request';
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
    private readonly actor: ActorVM,
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
              this.actor, 'job:status-requested', { jobId: jid }, 'job:status-result', 'job:status-failed',
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
      const progress$ = this.eventBus.get('job:report-progress').pipe(
        filter((e) => e.jobId === activeJobId),
      );
      const complete$ = this.eventBus.get('job:complete').pipe(
        filter((e) => e.jobId === activeJobId),
      );
      const fail$ = this.eventBus.get('job:fail').pipe(
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
        this.actor,
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
      this.actor,
      'yield:clone-token-requested',
      { resourceId },
      'yield:clone-token-generated',
      'yield:clone-token-failed',
    );
  }

  async fromToken(token: string): Promise<ResourceDescriptor> {
    const result = await busRequest<GetResourceByTokenResponse>(
      this.actor,
      'yield:clone-resource-requested',
      { token },
      'yield:clone-resource-result',
      'yield:clone-resource-failed',
    );
    return result.sourceResource;
  }

  async createFromToken(options: CreateFromTokenOptions): Promise<{ resourceId: string }> {
    return busRequest<{ resourceId: string }>(
      this.actor,
      'yield:clone-create',
      options as unknown as Record<string, unknown>,
      'yield:clone-created',
      'yield:clone-create-failed',
    );
  }

  clone(): void {
    this.http.emit('yield:clone', undefined);
  }
}
