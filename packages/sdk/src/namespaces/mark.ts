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
import { busRequest, isReportedJobResult } from '@semiont/core';
import { StreamObservable } from '../awaitable';
import { JobCancelledError, JobFailedError, JobFrames, JobStatusPoll, type JobFollowTiming } from './job-status-poll';
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
    private readonly timing: JobFollowTiming = {},
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
    // Confirmed write (matches `annotation()` above): await the gateway's
    // correlation-keyed reply and REJECT on failure, rather than fire-and-forget
    // an emit whose mark:delete-failed nobody awaited (.plans/bugs/BRIDGE-GAPS.md).
    await busRequest(
      this.transport,
      'mark:delete',
      { annotationId, resourceId },
    );
  }

  async archive(resourceId: ResourceId): Promise<void> {
    // Confirmed write: await the gateway's correlation-keyed reply and REJECT on
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
   * Replace a resource's own entity-type classification. The gateway diffs
   * `current` vs `updated` and folds the changes into `resource.entityTypes`
   * (mark:entity-tag-added/-removed → Weaver), so the change surfaces in
   * `browse.resources({ entityType })` and `getResourceEntityTypes`. A
   * **replace/diff** operation: pass the resource's current types as `current`,
   * the desired full set as `updated`.
   *
   * Confirmed write (like `delete`/`archive`): awaits the gateway's
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

      const poll = new JobStatusPoll(
        this.transport,
        (status) => {
          if (done) return;
          if (status.status === 'complete') {
            cleanup();
            // The `complete` event the stream did not carry, from the status.
            subscriber.next({
              kind: 'complete',
              data: {
                jobId: status.jobId,
                jobType: status.type,
                resourceId,
                // A job completed without a result is stored with an empty
                // one; the job:complete this stands for carried none.
                ...(isReportedJobResult(status.result) ? { result: status.result } : {}),
              },
            });
            subscriber.complete();
          } else if (status.status === 'failed') {
            cleanup();
            subscriber.error(new JobFailedError(status.error ?? 'Job failed', status.jobId));
          } else if (status.status === 'cancelled') {
            cleanup();
            subscriber.error(new JobCancelledError(status.jobId));
          }
        },
        this.timing,
      );

      const cleanup = () => {
        done = true;
        poll.stop();
      };

      // Subscribe to the unified job lifecycle before the job exists:
      // `JobFrames` holds what arrives until the job's id is known, and
      // delivers only this job's.
      let activeJobId: string | null = null;
      const frames = new JobFrames(this.bus);
      const progress$ = frames.of('job:report-progress');
      const complete$ = frames.of('job:complete');
      const fail$ = frames.of('job:fail');

      // Only a TERMINAL failure ends the progress stream. `takeUntil(fail$)`
      // silenced progress on a retryable failure too, so a run that recovered
      // went quiet even when the stream itself survived (P5).
      const terminalFail$ = fail$.pipe(filter((e) => e.willRetry !== true));
      const progressSub = progress$
        .pipe(takeUntil(merge(complete$, terminalFail$)))
        .subscribe((e) => {
          if (e.progress) subscriber.next({ kind: 'progress', data: e.progress });
          if (activeJobId) poll.heard(activeJobId);
        });

      const completeSub = complete$.subscribe((e) => {
        cleanup();
        subscriber.next({ kind: 'complete', data: e });
        subscriber.complete();
      });

      const failSub = fail$.subscribe((e) => {
        // A retryable failure is an EVENT: the queue re-queues the job and a
        // fresh worker continues it, so ending the stream here would report a
        // recovering run as a failed one. `willRetry` is the worker's report
        // of what the queue will do, from the queue's own predicate. Absent
        // (an older worker) reads as terminal — the safe direction: a stream
        // that ends early is visible, one that never ends is not (L1).
        if (e.willRetry === true) {
          subscriber.next({ kind: 'failed', data: e });
          // The status poll must not fire for the dead attempt; the retried
          // attempt starts it again on its first progress frame.
          poll.stop();
          return;
        }
        cleanup();
        subscriber.error(new JobFailedError(e.error, e.jobId));
      });

      this.dispatchAssist(resourceId, motivation, options)
        .then(({ jobId }) => {
          if (jobId && !done) {
            activeJobId = jobId;
            poll.heard(jobId);
            frames.started(jobId);
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
    this.bus.emit('mark:requested', { source, selector, motivation });
  }

  requestAssist(motivation: Motivation, options: MarkAssistOptions, correlationId?: string): void {
    this.bus.emit('mark:assist-request', {
      motivation,
      options,
      ...(correlationId ? { correlationId } : {}),
    } as components['schemas']['MarkAssistRequestEvent']);
  }

  submit(input: components['schemas']['MarkSubmitEvent']): void {
    this.bus.emit('mark:submit', input);
  }

  cancelPending(): void {
    this.bus.emit('mark:cancel-pending', undefined);
  }

  dismissProgress(): void {
    this.bus.emit('mark:progress-dismiss', undefined);
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
