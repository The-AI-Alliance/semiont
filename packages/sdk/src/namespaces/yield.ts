import { merge } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import type {
  ResourceId,
  EventBus,
  GatheredContext,
  GenerationJobParams,
  components,
} from '@semiont/core';
import { cloneFormat, deriveStorageUri, getPrimaryRepresentation } from '@semiont/core';

import type { ITransport, IContentTransport } from '@semiont/core';
import { busRequest, isReportedJobResult } from '@semiont/core';
import { StreamObservable, UploadObservable } from '../awaitable';
import { GenerationStallError, deriveStallDeadlineMs } from './generation-stall';
import { JobCancelledError, JobFailedError, JobFrames, JobStatusPoll, type JobFollowTiming } from './job-status-poll';
import type {
  YieldNamespace as IYieldNamespace,
  CreateResourceInput,
  GenerationOptions,
  CreateFromTokenOptions,
  YieldGenerationEvent,
} from './types';

import type { ResourceDescriptor } from '@semiont/core';

type CloneResourceWithTokenResponse = components['schemas']['CloneResourceWithTokenResponse'];

export class YieldNamespace implements IYieldNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
    private readonly content: IContentTransport,
    private readonly timing: JobFollowTiming = {},
  ) {}

  resource(data: CreateResourceInput): UploadObservable {
    // `Buffer` is a Node global; referencing it bare in the browser throws
    // ReferenceError. Guard with a typeof check so this code runs in both
    // environments (browser uploads File, Node workers upload Buffer).
    const totalBytes = (typeof Buffer !== 'undefined' && data.file instanceof Buffer)
      ? data.file.length
      : (data.file as File).size;
    return new UploadObservable((subscriber) => {
      // `started` fires synchronously so subscribers can render an upload-
      // in-progress indicator before any I/O begins.
      subscriber.next({ phase: 'started', totalBytes });
      let cancelled = false;
      const abortController = new AbortController();
      this.content.putBinary(
        {
          name: data.name,
          file: data.file,
          format: data.format,
          storageUri: data.storageUri,
          ...(data.entityTypes ? { entityTypes: data.entityTypes } : {}),
          ...(data.language ? { language: data.language } : {}),
          ...(data.sourceAnnotationId ? { sourceAnnotationId: data.sourceAnnotationId } : {}),
          ...(data.sourceResourceId ? { sourceResourceId: data.sourceResourceId } : {}),
          ...(data.generationPrompt ? { generationPrompt: data.generationPrompt } : {}),
          ...(data.generator ? { generator: data.generator } : {}),
          ...(data.jobId ? { jobId: data.jobId } : {}),
          ...(data.isDraft !== undefined ? { isDraft: data.isDraft } : {}),
        },
        {
          // Byte-progress hook. `HttpContentTransport` calls it as the
          // bytes are sent; `LocalContentTransport` has no wire to observe.
          onProgress: ({ bytesUploaded, totalBytes: txTotal }) => {
            if (cancelled) return;
            // Prefer the transport's reported total; fall back to the
            // pre-flight size if the transport reports 0 (chunked encoding
            // or indeterminate length).
            const total = txTotal > 0 ? txTotal : totalBytes;
            subscriber.next({ phase: 'progress', bytesUploaded, totalBytes: total });
          },
          signal: abortController.signal,
        },
      )
        .then((result) => {
          if (cancelled) return;
          subscriber.next({
            phase: 'finished',
            resourceId: result.resourceId,
          });
          subscriber.complete();
        })
        .catch((err) => {
          if (!cancelled) subscriber.error(err);
        });
      return () => {
        cancelled = true;
        // Cancel the upload when the subscriber unsubscribes: over HTTP its
        // connection is closed. The transport's rejection is the signal's
        // reason, which `cancelled` keeps from the subscriber.
        abortController.abort();
      };
    });
  }

  /**
   * Grounded generation — translate, summarize, answer, synthesize; the role is
   * carried by `options.task`/`options.prompt` (+ `language`, `outputMediaType`).
   * The context IS the argument: `focus.kind` decides the shape, and the job's
   * ids are DERIVED from the focus (single source of truth — a mismatched
   * rid/aid pair is unrepresentable):
   *
   * - `resource` focus (from `gather.resource`) — the job scopes to
   *   `focus.resource`; on completion the worker mints a navigable
   *   source→derived reference annotation (provenance).
   * - `annotation` focus (from `gather.annotation`) — the job scopes to
   *   `focus.sourceResource`, and the worker auto-binds the new resource to
   *   `focus.annotation` (derived server-side; nothing rides the wire twice).
   *
   * A context without a usable focus throws synchronously — the runtime half
   * of the schema's `required: focus` for values whose type history was
   * severed (wire JSON, storage, casts). Never guesses, never defaults.
   *
   * ⚠️ Cold `StreamObservable`: do NOT both `.subscribe(...)` and `await` the same
   * instance — that fires the job twice. Use `.run(onNext)` for progress + result.
   */
  fromContext(
    context: GatheredContext,
    options: GenerationOptions,
  ): StreamObservable<YieldGenerationEvent> {
    // The wire carries NO ids for generation — the dispatcher derives them
    // from the context's focus and rejects a caller-supplied value. The rid
    // derived here is CLIENT-side only, for the poll-fallback's synthesized
    // complete event (JobStatusResponse has no resourceId). The guard stays:
    // fail fast locally with the same message the dispatcher would send.
    const focus = context?.focus;
    const displayRid =
      focus?.kind === 'resource' && typeof focus.resource?.['@id'] === 'string'
        ? focus.resource['@id']
        : focus?.kind === 'annotation' && typeof focus.sourceResource?.['@id'] === 'string'
          ? focus.sourceResource['@id']
          : undefined;
    if (displayRid === undefined) {
      throw new Error(
        'yield.fromContext: context has no usable focus — pass a GatheredContext '
        + 'produced by gather.resource(...) or gather.annotation(...).',
      );
    }
    // `stallDeadlineMs` is a CLIENT-only guard knob — stripped here so `params`
    // stays exactly the WIRE's GenerationJobParams (TS spreads bypass
    // excess-property checks, so an unstripped field would silently ride
    // `job:create`).
    const { stallDeadlineMs, ...wireOptions } = options;
    const stallMs = stallDeadlineMs ?? deriveStallDeadlineMs(options.maxTokens);
    return this.runGeneration(displayRid, { ...wireOptions, context }, stallMs);
  }

  /**
   * Shared job-lifecycle driver for `fromContext`. Emits `job:create`
   * (jobType `generation`) with the supplied `params` — typed as the WIRE's
   * `GenerationJobParams`, so the write side and the worker's guard share one
   * contract — then streams the unified
   * `job:report-progress`/`job:complete`/`job:fail` lifecycle (with the status
   * poll that stands in for a frame the stream did not carry) as
   * `YieldGenerationEvent`s, resolving on the terminal `complete`.
   *
   * `resourceId` is CLIENT-side display only (the poll-synthesized complete
   * event) — it is deliberately NOT sent on the wire. `stallMs` is the ONE
   * stall guard: it lives in this producer so `await`, `.run()`, and the
   * state unit's drive all share it.
   */
  private runGeneration(
    resourceId: ResourceId,
    params: GenerationJobParams,
    stallMs: number,
  ): StreamObservable<YieldGenerationEvent> {
    return new StreamObservable<YieldGenerationEvent>((subscriber) => {
      let done = false;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;

      // `job:report-progress`, `job:complete`, and `job:fail` reach us on the
      // always-on global bridge: the worker emits them to every client. We
      // deliberately do NOT call `transport.subscribeToResource(resourceId)`:
      // a resource's scope carries none of the three, and joining it can cost
      // the HTTP transport a handoff to a second connection on every
      // generation. Symmetric with `mark.assist`.

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
            subscriber.error(new JobFailedError(status.error ?? 'Generation failed', status.jobId));
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
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      };

      // Subscribe to the unified job lifecycle filtered by this job's
      // jobId (assigned by `job:create` below). Auto-bind (resolving the
      // source reference to the generated resource) is handled in
      // Stower's `yield:create` handler when `generatedFrom.annotationId`
      // is present — not here, because the generated resource id is
      // assigned by Stower, not by the worker.
      let activeJobId: string | null = null;
      const frames = new JobFrames(this.bus);
      const progress$ = frames.of('job:report-progress');
      const complete$ = frames.of('job:complete');
      const fail$ = frames.of('job:fail');
      // Only a failure the queue will not try again is an end. One it will
      // (`willRetry`) is followed past, as `mark.assist` follows it; absent
      // reads as final, so a worker that does not say cannot hang the stream.
      const terminalFail$ = fail$.pipe(filter((e) => e.willRetry !== true));

      // The ONE stall guard: armed at subscribe, re-armed on every event,
      // cleared by any terminal. Firing asks for THAT job to be cancelled, by
      // its id: a cancellation by category would end every pending
      // generation, whoever asked for it. A pending job is cancelled
      // outright; a running one is left to its worker. A job whose creation
      // was never answered has no id, and there is nothing to cancel. Then
      // the stream errors with the stall error.
      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (done) return;
          const stalledJobId = activeJobId;
          cleanup();
          if (stalledJobId !== null) {
            void busRequest(this.transport, 'job:cancel-requested', { jobId: stalledJobId }).catch(() => {});
          }
          // subscriber.error runs the producer teardown, which unsubscribes
          // the three lifecycle subs — no manual unsubscribe needed here.
          subscriber.error(new GenerationStallError(stallMs, stalledJobId));
        }, stallMs);
      };

      const progressSub = progress$
        .pipe(takeUntil(merge(complete$, terminalFail$)))
        .subscribe((e) => {
          if (e.progress) subscriber.next({ kind: 'progress', data: e.progress });
          if (activeJobId) poll.heard(activeJobId);
          armStall();
        });

      const completeSub = complete$.subscribe((e) => {
        cleanup();
        subscriber.next({ kind: 'complete', data: e });
        subscriber.complete();
      });

      const failSub = fail$.subscribe((e) => {
        if (e.willRetry === true) {
          subscriber.next({ kind: 'failed', data: e });
          // The attempt that died is not asked about: the next attempt's
          // first frame starts the silence again. The setback was heard, so
          // the stall deadline starts again too: one left running would
          // cancel the attempt that is coming.
          poll.stop();
          armStall();
          return;
        }
        cleanup();
        subscriber.error(new JobFailedError(e.error, e.jobId));
      });

      armStall();

      busRequest(
        this.transport,
        'job:create',
        {
          jobType: 'generation',
          params,
        },
      ).then(({ jobId }) => {
        if (jobId && !done) {
          activeJobId = jobId;
          poll.heard(jobId);
          frames.started(jobId);
        }
      }).catch((error) => {
        // If the StreamObservable has already completed (job:complete arrived
        // before busRequest resolved, or the consumer disposed the client
        // mid-flight), don't propagate — the subscriber is gone and RxJS
        // would host the error as an uncaught exception.
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

  async cloneToken(resourceId: ResourceId): Promise<CloneResourceWithTokenResponse> {
    return busRequest(
      this.transport,
      'yield:clone-token-requested',
      { resourceId },
    );
  }

  async fromToken(token: string): Promise<ResourceDescriptor> {
    const result = await busRequest(
      this.transport,
      'yield:clone-resource-requested',
      { token },
    );
    return result.sourceResource as ResourceDescriptor;
  }

  async createFromToken(options: CreateFromTokenOptions): Promise<{ resourceId: ResourceId }> {
    // The clone's bytes ride the upload path, never the bus: fetch the
    // source, apply the clone-format gate (authorable sources keep their base
    // type, everything else falls back to text/plain), and put the bytes with
    // the token — the Archivist stores them and routes creation through
    // `yield:clone-create`.
    const source = await this.fromToken(options.token);
    const format = cloneFormat(getPrimaryRepresentation(source)?.mediaType);
    const file = typeof Buffer !== 'undefined'
      ? Buffer.from(options.content)
      : new File([options.content], options.name, { type: format });
    return this.content.putBinary({
      name: options.name,
      file,
      format,
      storageUri: deriveStorageUri(options.name, format),
      cloneToken: options.token,
      ...(options.archiveOriginal !== undefined ? { archiveOriginal: options.archiveOriginal } : {}),
    });
  }

  clone(): void {
    this.bus.emit('yield:clone', undefined);
  }
}
