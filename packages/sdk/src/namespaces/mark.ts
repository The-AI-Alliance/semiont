import { merge } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import {
  annotationId as toAnnotationId,
  resourceId as toResourceId,
} from '@semiont/core';
import type {
  ResourceId,
  AnnotationId,
  Motivation,
  EventBus,
  components,
} from '@semiont/core';
import type { ITransport } from '@semiont/core';
import { busRequest } from '@semiont/core';
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

  async annotation(input: CreateAnnotationInput): Promise<{ annotationId: AnnotationId }> {
    // The wire schema (`MarkCreateRequest`) carries `resourceId` separately
    // for routing — we derive it from `input.target.source`, which is the
    // same value semantically.
    const resourceId = toResourceId(input.target.source);
    const result = await busRequest(
      this.transport,
      'mark:create-request',
      { resourceId, request: input },
    );
    return { annotationId: toAnnotationId(result.annotationId) };
  }

  async delete(resourceId: ResourceId, annotationId: AnnotationId): Promise<void> {
    // Confirmed write (matches `annotation()` above): await the backend's
    // correlation-keyed reply and REJECT on failure, rather than fire-and-forget
    // an emit whose mark:delete-failed nobody awaited (.plans/bugs/BRIDGE-GAPS.md).
    await busRequest(
      this.transport,
      'mark:delete',
      { annotationId, resourceId },
    );
  }

  async archive(resourceId: ResourceId): Promise<void> {
    // Confirmed write: await the backend's correlation-keyed reply and REJECT on
    // failure, rather than fire-and-forget an emit whose failure had nowhere to go
    // (.plans/bugs/BRIDGE-GAPS.md).
    await busRequest(
      this.transport,
      'mark:archive',
      { resourceId },
    );
  }

  async unarchive(resourceId: ResourceId): Promise<void> {
    await busRequest(
      this.transport,
      'mark:unarchive',
      { resourceId },
    );
  }

  /**
   * Replace a resource's own entity-type classification. The backend diffs
   * `current` vs `updated` and folds the changes into `resource.entityTypes`
   * (mark:entity-tag-added/-removed → graph consumer), so the change surfaces in
   * `browse.resources({ entityType })` and `getResourceEntityTypes`. A
   * **replace/diff** operation: pass the resource's current types as `current`,
   * the desired full set as `updated`.
   *
   * Confirmed write (like `delete`/`archive`): awaits the backend's
   * correlation-keyed reply and REJECTS on failure rather than fire-and-forget an
   * emit whose failure had nowhere to go (.plans/bugs/BRIDGE-GAPS.md).
   */
  async updateEntityTypes(resourceId: ResourceId, current: string[], updated: string[]): Promise<void> {
    await busRequest(
      this.transport,
      'mark:update-entity-types',
      { resourceId, currentEntityTypes: current, updatedEntityTypes: updated },
    );
  }

  assist(resourceId: ResourceId, motivation: Motivation, options: MarkAssistOptions): StreamObservable<MarkAssistEvent> {
    return new StreamObservable<MarkAssistEvent>((subscriber) => {
      let done = false;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      let pollInterval: ReturnType<typeof setInterval> | null = null;

      // `job:report-progress`, `job:complete`, and `job:fail` all reach us
      // on the always-on global bridge — the worker dual-emits the
      // resource-broadcast ones (`job:complete`/`job:fail`) globally as well
      // as scoped, so the dispatching caller gets them without a scoped
      // subscription. We deliberately do NOT call
      // `transport.subscribeToResource(resourceId)` here: that mutates the
      // SSE channel set, which can only change by tearing down and
      // re-opening the connection, so it forced a reconnect on every assist
      // and dropped in-flight `browse.*` results in the reconnect gap. See
      // Link 1 in .plans/SEMIONT-BUG-browse-annotations.md.

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
            busRequest(
              this.transport, 'job:status-requested', { jobId },
            ).then((status) => {
                if (done) return;
                if (status.status === 'complete') {
                  cleanup();
                  // Synthesize a `complete` event from polled status.
                  subscriber.next({
                    kind: 'complete',
                    data: {
                      jobId,
                      jobType: (status.type ?? 'annotation') as components['schemas']['JobType'],
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
          // If the StreamObservable has already completed (e.g. job:complete
          // arrived before dispatchAssist resolved, or the consumer disposed
          // the client mid-flight), don't propagate the error — there is no
          // live subscriber to receive it, and RxJS would host it as an
          // uncaught exception.
          if (done) return;
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
    source: ResourceId,
    selector: components['schemas']['MarkRequestedEvent']['selector'],
    motivation: Motivation,
  ): void {
    // Local emit: mark-state-unit subscribes via the local bus and routes by
    // `source` — resource-first, like every other mark.* method.
    this.bus.get('mark:requested').next({ source, selector, motivation });
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
      if (!options.schemaId) {
        throw new Error('mark.assist with motivation "tagging" requires options.schemaId');
      }
      if (!options.categories?.length) {
        throw new Error('mark.assist with motivation "tagging" requires a non-empty options.categories array');
      }
    } else if (motivation === 'linking') {
      if (!options.entityTypes?.length) throw new Error('mark.assist with motivation "linking" requires a non-empty entityTypes array');
    }

    const params: Record<string, unknown> = {};
    if (options.entityTypes) params.entityTypes = options.entityTypes;
    if (options.includeDescriptiveReferences !== undefined) params.includeDescriptiveReferences = options.includeDescriptiveReferences;
    if (options.instructions !== undefined) params.instructions = options.instructions;
    if (options.density !== undefined) params.density = options.density;
    if (options.tone !== undefined) params.tone = options.tone;
    if (options.language !== undefined) params.language = options.language;
    if (options.sourceLanguage !== undefined) params.sourceLanguage = options.sourceLanguage;
    if (options.schemaId !== undefined) params.schemaId = options.schemaId;
    if (options.categories !== undefined) params.categories = options.categories;

    return busRequest(
      this.transport,
      'job:create',
      { jobType, resourceId, params },
    );
  }
}
