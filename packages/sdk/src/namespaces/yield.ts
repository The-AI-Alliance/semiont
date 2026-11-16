import { merge } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import type {
  ResourceId,
  EventBus,
  components,
  GatheredContext,
  GenerationJobParams,
} from '@semiont/core';
import { resourceId as toResourceId } from '@semiont/core';

import type { ITransport, IContentTransport } from '@semiont/core';
import { busRequest } from '@semiont/core';
import { StreamObservable, UploadObservable } from '../awaitable';
import { GenerationStallError, deriveStallDeadlineMs } from './generation-stall';
import type {
  YieldNamespace as IYieldNamespace,
  CreateResourceInput,
  GenerationOptions,
  CreateFromTokenOptions,
  YieldGenerationEvent,
} from './types';

import type { ResourceDescriptor } from '@semiont/core';

export class YieldNamespace implements IYieldNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
    private readonly content: IContentTransport,
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
          ...(data.isDraft !== undefined ? { isDraft: data.isDraft } : {}),
        },
        {
          // Byte-progress hook. Honored by `HttpContentTransport`'s XHR
          // path; ignored by ky-path uploads (no `onProgress` consumer)
          // and by `LocalContentTransport` (no wire to observe).
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
            resourceId: toResourceId(result.resourceId as string),
          });
          subscriber.complete();
        })
        .catch((err) => {
          if (!cancelled) subscriber.error(err);
        });
      return () => {
        cancelled = true;
        // Abort the in-flight HTTP request when the subscriber unsubscribes.
        // Honored by `HttpContentTransport`'s XHR path (calls `xhr.abort()`);
        // ky-path uploads complete in the background after abort and the
        // `cancelled` flag suppresses the `then`/`catch` callbacks.
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
    // The wire carries NO ids for generation (GENERATION-WIRE-CONTEXT D1) —
    // the dispatcher derives them from the context's focus and rejects a
    // caller-supplied value. The rid derived here is CLIENT-side only, for the
    // poll-fallback's synthesized complete event (D4: JobStatusResponse has no
    // resourceId). The guard stays: fail fast locally with the same message
    // the dispatcher would send.
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
    // stays exactly the WIRE's GenerationJobParams (GWC discipline: TS spreads
    // bypass excess-property checks, so an unstripped field would silently
    // ride `job:create`).
    const { stallDeadlineMs, ...wireOptions } = options;
    const stallMs = stallDeadlineMs ?? deriveStallDeadlineMs(options.maxTokens);
    return this.runGeneration(toResourceId(displayRid), { ...wireOptions, context }, stallMs);
  }

  /**
   * Shared job-lifecycle driver for `fromContext`. Emits `job:create`
   * (jobType `generation`) with the supplied `params` — typed as the WIRE's
   * `GenerationJobParams`, so the write side and the worker's guard share one
   * contract — then streams the unified
   * `job:report-progress`/`job:complete`/`job:fail` lifecycle (with a polled
   * `job:status` fallback) as `YieldGenerationEvent`s, resolving on the
   * terminal `complete`.
   */
  /** `resourceId` is CLIENT-side display only (the poll-synthesized complete
   *  event, D4) — it is deliberately NOT sent on the wire. `stallMs` is the
   *  ONE stall guard (FLOW-LIFECYCLE-CONVERGENCE D1): it lives in this
   *  producer so `await`, `.run()`, and the state unit's drive all share it. */
  private runGeneration(
    resourceId: ResourceId,
    params: GenerationJobParams,
    stallMs: number,
  ): StreamObservable<YieldGenerationEvent> {
    return new StreamObservable<YieldGenerationEvent>((subscriber) => {
      let done = false;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      let pollInterval: ReturnType<typeof setInterval> | null = null;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;

      // `job:report-progress`, `job:complete`, and `job:fail` reach us on the
      // always-on global bridge — the worker dual-emits the resource-broadcast
      // ones globally as well as scoped. We deliberately do NOT call
      // `transport.subscribeToResource(resourceId)`: mutating the SSE channel
      // set forces a reconnect on every generation, which dropped in-flight
      // `browse.*` results in the reconnect gap. Symmetric with `mark.assist`.
      // See Link 1 in .plans/SEMIONT-BUG-browse-annotations.md.

      const cleanup = () => {
        done = true;
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      };

      const resetPollTimer = (jid: string) => {
        if (pollTimer) clearTimeout(pollTimer);
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        pollTimer = setTimeout(() => {
          if (done) return;
          pollInterval = setInterval(() => {
            if (done) return;
            busRequest(
              this.transport, 'job:status-requested', { jobId: jid },
            ).then((status) => {
                if (done) return;
                if (status.status === 'complete') {
                  cleanup();
                  // Synthesize a `complete` event from polled status.
                  subscriber.next({
                    kind: 'complete',
                    data: {
                      jobId: jid,
                      jobType: (status.type ?? 'generation') as components['schemas']['JobType'],
                      resourceId: resourceId as string,
                      result: status.result,
                    },
                  });
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

      // The ONE stall guard (FLOW-LIFECYCLE-CONVERGENCE D1): armed at
      // subscribe, re-armed on every event, cleared by any terminal. Firing
      // requests the server-side cancel — the queue kills pending jobs;
      // there is no worker-kill channel, so a hung RUNNING job dies at its
      // own pace — then errors the stream with the typed stall error.
      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (done) return;
          const stalledJobId = activeJobId;
          cleanup();
          void busRequest(
            this.transport, 'job:cancel-requested', { jobType: 'generation' },
          ).catch(() => {});
          // subscriber.error runs the producer teardown, which unsubscribes
          // the three lifecycle subs — no manual unsubscribe needed here.
          subscriber.error(new GenerationStallError(stallMs, stalledJobId));
        }, stallMs);
      };

      const progressSub = progress$
        .pipe(takeUntil(merge(complete$, fail$)))
        .subscribe((e) => {
          if (e.progress) subscriber.next({ kind: 'progress', data: e.progress });
          if (activeJobId) resetPollTimer(activeJobId);
          armStall();
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
          resetPollTimer(jobId);
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

  async cloneToken(resourceId: ResourceId): Promise<{ token: string; expiresAt: string }> {
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
    const result = await busRequest(
      this.transport,
      'yield:clone-create',
      options,
    );
    return { resourceId: toResourceId(result.resourceId) };
  }

  clone(): void {
    this.bus.get('yield:clone').next(undefined);
  }
}
