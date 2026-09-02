/**
 * Worker Process Entry Point
 *
 * One worker process serves a single software-agent identity — one
 * `(inferenceProvider, model)` pair. The session it owns is
 * authenticated *as that agent* (`/api/tokens/agent`), so every event
 * the worker emits attributes to the agent at the bus seat. Multiple
 * agents on the same host run as multiple worker processes side by
 * side; their job-claim subscriptions don't interfere because each
 * agent only subscribes to the job types its inference engine is
 * configured to serve.
 *
 * `createJobClaimAdapter` handles the reactive contract (SSE
 * subscription, claim, completion tracking). This file wires the
 * job processors to the adapter and drives lifecycle emissions.
 */

import { createJobClaimAdapter, type JobClaimAdapter, type ActiveJob } from './job-claim-adapter';
import {
  asJobParams,
  isJobType,
  type AssessmentDetectionParams,
  type CommentDetectionParams,
  type DetectionParams,
  type HighlightDetectionParams,
  type JobType,
  type TagDetectionParams,
} from './types';
import type { SemiontSession } from '@semiont/sdk';
import { type HttpTransport } from '@semiont/http-transport';
import { isGenerationJobParams, getPrimaryMediaType, assembleAnnotation, resourceId as makeResourceId, findClaimSpan, capabilitiesOf, type EventMap } from '@semiont/core';

import type { InferenceClient } from '@semiont/inference';
import type { Logger, components } from '@semiont/core';
import { extractPdfTextLayer, type AnchoredTextStore, type ContentReads } from '@semiont/content';
import { prepareDetection } from './workers/detection/prepare-detection';
import { SpanKind, recordJobOutcome, withSpan } from '@semiont/observability';
import {
  processHighlightJob,
  processCommentJob,
  processAssessmentJob,
  processReferenceJob,
  processTagJob,
  processGenerationJob,
  buildPdfAnnotation,
  type OnProgress,
  type BuildAnnotation,
} from './processors';

/**
 * The ONE derivation for a job's associated reference/annotation id
 * (GENERATION-WIRE-CONTEXT D3). Generation params no longer carry
 * `referenceId` on the wire — the context's focus is authoritative — so for
 * generation jobs the id comes from `focus.annotation.id` (annotation focus)
 * or is undefined (resource focus). Non-generation jobTypes (detection
 * echoes) keep their own `params.referenceId` passthrough.
 */
export function referenceIdOf(job: { type: string; params: Record<string, unknown> }): string | undefined {
  if (job.type === 'generation') {
    const context = job.params.context as { focus?: { kind?: unknown; annotation?: { id?: unknown } } } | undefined;
    const focus = context?.focus;
    if (focus?.kind === 'annotation' && typeof focus.annotation?.id === 'string') {
      return focus.annotation.id;
    }
    return undefined;
  }
  const ref = job.params.referenceId;
  return typeof ref === 'string' ? ref : undefined;
}

type Agent = components['schemas']['Agent'];

/**
 * What the user is told when a resource cannot be read. Keyed by the
 * extraction vocabulary, minus `no-extractor` — that one is a user error
 * (detection asked of a media type that can never yield text) and throws.
 */
export interface WorkerProcessConfig {
  /**
   * The session authenticated as this worker's software-agent identity.
   * Bus emits through this session attribute to that agent.
   */
  session: SemiontSession;
  /**
   * The job types this agent serves. Today every job type a worker
   * subscribes to runs through the same inference engine — different
   * inference engines mean different agents and therefore different
   * worker processes.
   */
  jobTypes: string[];
  inferenceClient: InferenceClient;
  /**
   * The agent (Software) record stamped onto annotations as `generator`
   * and onto resources as `wasAttributedTo`. Same identity that the
   * session is authenticated as.
   */
  generator: Agent;
  /**
   * The anchored-text cache the extraction seam reads and writes
   * (PERSIST-ANCHORS P2d) — the adapter over this worker's content
   * transport, constructed once per agent process by worker-runtime.
   * The session's own content transport is private to the client, so
   * the store rides the config from where the transport is in hand.
   */
  anchoredTextStore: AnchoredTextStore;
  /**
   * The resource's bytes, for the detection extraction seam. Dials the
   * Archivist rather than the gateway (SINGLE-KB-MOUNT P4) — which is why it
   * rides the config instead of coming off the session: the session's
   * transport is pointed at the gateway, and this read should not be.
   */
  contentReads: ContentReads;
  logger: Logger;
}

/**
 * Route `transport.emit` calls — choosing resource-scoped vs global based
 * on whether the event is a cross-subscriber broadcast.
 */
async function emitEvent<K extends keyof EventMap>(
  session: SemiontSession,
  channel: K,
  payload: EventMap[K],
): Promise<void> {
  // All worker-emitted bus events are global. `job:complete` / `job:fail`
  // are global, `jobId`-keyed correlation signals (#847): the dispatching
  // caller filters by `jobId`, and resource viewers filter the same global
  // stream by `resourceId`. No resource-scoped copy (see RESOURCE_BROADCAST_TYPES).
  await session.client.transport.emit(channel, payload as EventMap[K]);
}

export function startWorkerProcess(config: WorkerProcessConfig): JobClaimAdapter {
  const { session, logger } = config;
  // Workers are HTTP-bound today; the actor is needed for the job-claim
  // protocol (SSE subscribe + ad-hoc channel adds). Cast to HttpTransport
  // is intentional: `LocalTransport` workers don't exist. The adapter
  // itself is transport-neutral — see `WorkerBus` in
  // packages/sdk/src/state/lib/worker-bus.ts.
  const httpTransport = session.client.transport as HttpTransport;
  const adapter = createJobClaimAdapter({
    bus: httpTransport.actor,
    jobTypes: config.jobTypes,
  });

  // Checkpointed resume (ABANDONED-INFERENCE P2): units a reference run
  // completes are accumulated here so the failure path can carry them on
  // job:fail — the queue records them and a retry skips them. Shared
  // between handleJob (which fills it) and the catch below (which reads
  // it); cleared on every terminal outcome.
  const completedUnitsByJob = new Map<string, string[]>();

  adapter.activeJob$.subscribe((job) => {
    if (!job) return;
    logger.info('Processing job', { jobId: job.jobId, type: job.type, resourceId: job.resourceId });
    handleJob(adapter, config, job, completedUnitsByJob)
      .then(() => {
        completedUnitsByJob.delete(job.jobId);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Job failed', { jobId: job.jobId, error: message, stack: error instanceof Error ? error.stack : undefined });
        const completedUnits = completedUnitsByJob.get(job.jobId);
        completedUnitsByJob.delete(job.jobId);
        const failAnnotationId = referenceIdOf(job);
        if (isJobType(job.type)) {
          emitEvent(session, 'job:fail', {
            resourceId: job.resourceId,
            jobId: job.jobId,
            jobType: job.type,
            ...(failAnnotationId ? { annotationId: failAnnotationId } : {}),
            error: message,
            ...(completedUnits && completedUnits.length > 0 ? { completedUnits } : {}),
          }).catch(() => {});
        }
        adapter.failJob(job.jobId, message);
      });
  });

  adapter.start();
  return adapter;
}

// Exported for unit testing — the orchestration (claim→fetch→process→emit→complete)
// is the only thing not otherwise exercised by processors.test.ts.
// Do not call from outside the worker process.
export async function handleJob(
  adapter: JobClaimAdapter,
  config: WorkerProcessConfig,
  job: ActiveJob,
  // The subscription in startWorkerProcess passes its shared accumulator so
  // the failure path can read what the reference branch committed
  // (checkpointed resume); standalone callers may omit it — a fresh map
  // changes no behavior, only discards the checkpoint on return.
  completedUnitsByJob: Map<string, string[]> = new Map(),
): Promise<void> {
  const start = performance.now();
  let outcome: 'completed' | 'failed' = 'completed';
  try {
    return await withSpan(
      `job:${job.type}`,
      () => handleJobInner(adapter, config, job, completedUnitsByJob),
      {
        kind: SpanKind.CONSUMER,
        attrs: {
          'job.type': job.type,
          'job.id': job.jobId,
          'resource.id': job.resourceId,
        },
      },
    );
  } catch (err) {
    outcome = 'failed';
    throw err;
  } finally {
    recordJobOutcome(job.type, outcome, performance.now() - start);
  }
}

async function handleJobInner(
  adapter: JobClaimAdapter,
  config: WorkerProcessConfig,
  job: ActiveJob,
  completedUnitsByJob: Map<string, string[]>,
): Promise<void> {
  const { session, inferenceClient, generator } = config;
  const { userId, jobId } = job;
  // `jobType` is a required, enumerated field on every lifecycle command, but
  // arrives off the bus as a plain string. Narrow once here so the emits below
  // are checked against the wire contract instead of asserted past it.
  if (!isJobType(job.type)) {
    adapter.failJob(jobId, `Unrecognized job type: ${job.type}`);
    return;
  }
  const jobType: JobType = job.type;
  // The job arrives off the bus with a plain-string id — this is the entry
  // boundary, so brand once here rather than casting at every call that wants
  // a `ResourceId` (BRAND-UPSTREAM).
  const resourceId = makeResourceId(job.resourceId);

  // Annotation-scoped jobs (today: generation, triggered from a
  // reference) carry the source annotation through every lifecycle
  // payload so the UI can attach visual feedback to that annotation.
  // Resource-scoped jobs (bulk reference/tag/highlight/comment/
  // assessment detection scanning a whole resource) leave it unset.
  const annotationId = referenceIdOf(job);
  // No `userId`: the job lifecycle commands declare only `_userId`, injected by
  // the gateway from the authenticated session. Spreading an extra field would
  // put out-of-contract data on a global channel — and would not be caught by
  // `emitEvent`'s typing, because TypeScript suppresses excess-property checks
  // for spreads and for variables passed by reference.
  const lifecycleBase = {
    resourceId, jobId, jobType,
    ...(annotationId ? { annotationId } : {}),
  };

  // ── Job lifecycle signaling ───────────────────────────────────────────
  // `job:start` / `job:report-progress` / `job:complete` / `job:fail`
  // are the ONE unified lifecycle family. Start/complete/fail are
  // persisted by Stower; progress is ephemeral UI feedback and Stower
  // ignores it. UI consumers filter by `jobType` and/or `annotationId`
  // in the payload.

  await emitEvent(session, 'job:start', lifecycleBase);

  if (!config.jobTypes.includes(jobType)) {
    adapter.failJob(jobId, `Worker not configured for job type: ${jobType}`);
    return;
  }

  // Detection needs the resource's text plus a media-appropriate way to anchor a
  // detected span. Both come from `prepareDetection`, which reads through the
  // same extractor registry the Smelter embeds from — so a resource that can be
  // embedded can be detected over, scanned PDFs included.
  //
  // Two failures, deliberately distinguished. A media type with no extractor at
  // all ('none' — a zip, an image) can never yield text, so asking to detect
  // over it is a user error and throws (surfaces as job:fail). A resource whose
  // extraction *failed* — encrypted, corrupt, a scan OCR could not read —
  // declines cleanly and completes the job saying which. Generation reads the
  // annotation in its params, not the source bytes, so it is not prepared here.
  let ready: { text: string; buildAnnotation: BuildAnnotation } | null = null;
  if (jobType !== 'generation') {
    const descriptor = await session.client.browse.resource(resourceId).fresh();
    const mediaType = getPrimaryMediaType(descriptor);
    // Its own span: extraction (fetch + decode, or a multi-second OCR pass on
    // a scanned PDF) is otherwise indistinguishable from inference in a
    // trace, which is exactly what made a 411 s opaque job hard to diagnose.
    const source = await withSpan(
      'detection:prepare',
      () => prepareDetection(mediaType ?? '', config.contentReads, resourceId, userId, generator, config.anchoredTextStore),
      { attrs: { 'resource.id': resourceId as unknown as string, 'media.type': mediaType ?? 'unknown' } },
    );

    if ('declined' in source) {
      if (source.declined === 'no-extractor') {
        throw new Error(`Cannot run ${jobType} on resource ${resourceId}: media type '${mediaType ?? 'unknown'}' has no extractable text to analyze`);
      }
      await emitEvent(session, 'job:complete', {
        ...lifecycleBase,
        result: {
          kind: 'declined',
          declined: true,
          reason: source.declined,
        },
      });
      adapter.completeJob();
      return;
    }
    ready = source;
  }

  const onProgress: OnProgress = (percentage, message, extra) => {
    // Progress doubles as the worker's liveness heartbeat: it feeds the
    // stall watchdog here and refreshes the gateway janitor's mtime
    // heartbeat via the job:report-progress mirror.
    //
    // `message` is a code plus typed params, forwarded verbatim — the
    // producer says WHAT happened and every client renders it in its own
    // language (ASSIST-PROGRESS-CONSOLIDATION A6). No sentence is composed
    // anywhere on this path. (P1 dropped the prose arg here as an interim;
    // P2 gave the processors codes worth forwarding.)
    adapter.touchActivity();
    emitEvent(session, 'job:report-progress', {
      ...lifecycleBase,
      percentage,
      progress: {
        percentage, message,
        ...(annotationId ? { annotationId } : {}),
        ...(extra ?? {}),
      },
    }).catch(() => {});
  };

  if (jobType === 'highlight-annotation') {
    const { annotations, result } = await processHighlightJob(
      ready!.text, inferenceClient, asJobParams<HighlightDetectionParams>(job.params), ready!.buildAnnotation, onProgress,
    );
    for (const ann of annotations) {
      await emitEvent(session, 'mark:create', { annotation: ann, resourceId });
    }
    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result,
    });
    adapter.completeJob();

  } else if (jobType === 'comment-annotation') {
    const { annotations, result } = await processCommentJob(
      ready!.text, inferenceClient, asJobParams<CommentDetectionParams>(job.params), ready!.buildAnnotation, onProgress,
    );
    for (const ann of annotations) {
      await emitEvent(session, 'mark:create', { annotation: ann, resourceId });
    }
    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result,
    });
    adapter.completeJob();

  } else if (jobType === 'assessment-annotation') {
    const { annotations, result } = await processAssessmentJob(
      ready!.text, inferenceClient, asJobParams<AssessmentDetectionParams>(job.params), ready!.buildAnnotation, onProgress,
    );
    for (const ann of annotations) {
      await emitEvent(session, 'mark:create', { annotation: ann, resourceId });
    }
    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result,
    });
    adapter.completeJob();

  } else if (jobType === 'reference-annotation') {
    // Checkpointed resume (ABANDONED-INFERENCE P2). A retried claim skips
    // the units earlier attempts completed; every remaining unit commits
    // through the callback the moment it finishes — the awaited emissions
    // ARE the acceptance that lets the unit count as complete, and the
    // accumulator feeds the job:fail payload if a later unit dies. The
    // post-run batch this replaces was N2's discard-everything mechanism.
    const params = asJobParams<DetectionParams>(job.params);
    const skip = new Set(job.completedUnits);
    const remaining = {
      ...params,
      entityTypes: params.entityTypes.filter((t) => !skip.has(String(t))),
    };
    const committed: string[] = [];
    completedUnitsByJob.set(job.jobId, committed);

    const { result } = await processReferenceJob(
      ready!.text, inferenceClient, remaining, ready!.buildAnnotation, onProgress, config.logger,
      async (unit, annotations) => {
        for (const ann of annotations) {
          await emitEvent(session, 'mark:create', { annotation: ann, resourceId });
        }
        committed.push(unit);
      },
    );
    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result,
    });
    adapter.completeJob();

  } else if (jobType === 'tag-annotation') {
    const { annotations, result } = await processTagJob(
      ready!.text, inferenceClient, asJobParams<TagDetectionParams>(job.params), ready!.buildAnnotation, onProgress,
    );
    for (const ann of annotations) {
      await emitEvent(session, 'mark:create', { annotation: ann, resourceId });
    }
    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result,
    });
    adapter.completeJob();

  } else if (jobType === 'generation') {
    // Trust-boundary narrowing: params crossed the wire as untyped JSON. The
    // guard checks the schema's required trio; a malformed bag fails the job
    // loudly here instead of surfacing as a mid-generation TypeError.
    if (!isGenerationJobParams(job.params)) {
      throw new Error(
        `generation job ${job.jobId}: params do not satisfy GenerationJobParams `
        + `(title, storageUri, and context are required)`,
      );
    }
    const genResult = await processGenerationJob(
      inferenceClient, job.params, onProgress, config.logger,
    );

    // Content never travels on the bus. Upload via the http-transport's
    // `client.yield.resource()` — same serializer the /know/compose
    // page uses, so the multipart wire shape has ONE definition.
    // The gateway writes content to disk and emits `yield:create`
    // internally; we only learn the new resourceId from the response.
    const genParams = job.params as {
      prompt?: string;
      language?: string;
      entityTypes?: string[];
    };
    // Annotation-focus generation auto-binds to the triggering reference; the
    // id is derived from the context's focus (the wire no longer carries it).
    const genReferenceId = referenceIdOf(job);

    // The Save location the user typed is AUTHORITATIVE and there is no
    // fallback (GENERATION-OUTPUT-FORMAT D6/D9). Deriving unconditionally
    // meant the artifact landed at file://<title-slug><ext> and renaming the
    // title MOVED THE FILE; a `||` fallback would now only hide a caller that
    // forgot. The guard above rejects an absent OR empty uri, so by here it
    // is a real location.
    const storageUri = job.params.storageUri;

    // Faithful and incurious (D7): the worker writes the requested bytes to
    // the requested URI and does NOT police the pair — a mismatch is a
    // user-intent question the form answers earlier and better, so refusing
    // here would turn a typo into a job failure discovered minutes later.
    // Deliberately NOT the `outputMediaType` precedent, which guards an
    // invariant only the worker can check.
    const expectedExtension = capabilitiesOf(genResult.format)?.extension;
    if (expectedExtension && !storageUri.toLowerCase().endsWith(expectedExtension)) {
      config.logger.warn('Storage URI extension does not match the generated format — writing it as requested', {
        jobId, storageUri, format: genResult.format, expectedExtension,
      });
    }

    const { resourceId: newResourceId } = await session.client.yield.resource({
      name: genResult.title,
      file: Buffer.from(genResult.content),
      format: genResult.format,
      storageUri,
      sourceResourceId: resourceId as unknown as string,
      ...(genReferenceId ? { sourceAnnotationId: genReferenceId } : {}),
      ...(genParams.prompt ? { generationPrompt: genParams.prompt } : {}),
      ...(genParams.language ? { language: genParams.language } : {}),
      ...(genParams.entityTypes && genParams.entityTypes.length > 0 ? { entityTypes: genParams.entityTypes } : {}),
      generator,
    });

    // Resource-focus generation has no triggering reference — mint a navigable
    // source→derived reference annotation (YIELD-FROM-RESOURCE Fork 2b) so the
    // derivation is a first-class edge, targeting the whole source resource
    // (resource-level, no selector). Annotation-focus generation instead auto-binds
    // the triggering reference via `sourceAnnotationId` on the upload above.
    if (!genReferenceId) {
      const { annotation: provenanceRef } = assembleAnnotation(
        {
          motivation: 'linking',
          target: { source: String(resourceId) },
          body: { type: 'SpecificResource', source: String(newResourceId), purpose: 'linking' },
        },
        generator,
      );
      await emitEvent(session, 'mark:create', { annotation: provenanceRef, resourceId });
    }

    // Inline citations: mint each as a linking annotation ON THE DERIVED
    // resource — the target anchors the claim, the body points at the cited
    // source — so citations are first-class references like any other.
    //
    // Anchoring branches on the artifact's anchoring model. Text formats
    // anchor by character offset into the DECODED text — consumers apply
    // selectors to the decoded string, not raw bytes (INLINE-CITATIONS P1).
    // A PDF anchors by PAGE GEOMETRY (PDF-GENERATION P4): the citation's
    // offsets index the Typst SOURCE and would render nothing, so each claim
    // is re-found in the artifact's own text layer (two-stage search — strict,
    // then break-aware for hyphenation) and located to rects. A claim the
    // search cannot find is dropped LOUDLY, never minted wrong.
    if (genResult.format === 'application/pdf' && genResult.citations.length > 0) {
      const layer = await extractPdfTextLayer(genResult.content);
      if (!layer) {
        config.logger.warn('PDF citations dropped — the generated artifact yielded no text layer', {
          jobId, resourceId: newResourceId, citations: genResult.citations.length,
        });
      } else {
        for (const citation of genResult.citations) {
          const span = findClaimSpan(layer, citation.exact);
          if (!span) {
            config.logger.warn('PDF citation dropped — claim not found in the rendered text layer', {
              jobId, resourceId: newResourceId, citedResourceId: citation.resourceId,
              exactPreview: citation.exact.slice(0, 80),
            });
            continue;
          }
          // The quote must be the RENDERED substring, not the source claim:
          // hyphenation drops characters, so the source string can fail
          // buildPdfAnnotation's containment invariant even though the span
          // was found — and W3C-wise the quote should be the text actually
          // under the rects, which is what re-anchoring will see.
          const citationRef = buildPdfAnnotation(
            layer,
            makeResourceId(String(newResourceId)),
            userId,
            generator,
            'linking',
            { exact: layer.text.slice(span.start, span.end), start: span.start, end: span.end },
            { type: 'SpecificResource', source: citation.resourceId, purpose: 'linking' },
          );
          await emitEvent(session, 'mark:create', { annotation: citationRef, resourceId: newResourceId });
        }
      }
    } else {
      for (const citation of genResult.citations) {
        const { annotation: citationRef } = assembleAnnotation(
          {
            motivation: 'linking',
            target: {
              source: String(newResourceId),
              selector: [
                { type: 'TextPositionSelector', start: citation.start, end: citation.end },
                { type: 'TextQuoteSelector', exact: citation.exact },
              ],
            },
            body: { type: 'SpecificResource', source: citation.resourceId, purpose: 'linking' },
          },
          generator,
        );
        await emitEvent(session, 'mark:create', { annotation: citationRef, resourceId: newResourceId });
      }
    }

    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result: { kind: 'generation', resourceId: newResourceId, resourceName: genResult.title, truncated: genResult.result.truncated },
    });
    adapter.completeJob();

  } else {
    adapter.failJob(jobId, `Unknown job type: ${jobType}`);
  }
}
