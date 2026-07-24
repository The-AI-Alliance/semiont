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
import type { SemiontSession } from '@semiont/sdk';
import { type HttpTransport } from '@semiont/http-transport';
import { getPrimaryMediaType, textExtractionOf, assembleAnnotation, type EventMap } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import type { Logger, ResourceId, components } from '@semiont/core';
import { deriveStorageUri } from '@semiont/content';
import { prepareDetection } from './workers/detection/prepare-detection';
import { SpanKind, recordJobOutcome, withSpan } from '@semiont/observability';
import {
  processHighlightJob,
  processCommentJob,
  processAssessmentJob,
  processReferenceJob,
  processTagJob,
  processGenerationJob,
  type OnProgress,
} from './processors';

type Agent = components['schemas']['Agent'];

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
  logger: Logger;
}

/**
 * Route `transport.emit` calls — choosing resource-scoped vs global based
 * on whether the event is a cross-subscriber broadcast.
 */
async function emitEvent<K extends keyof EventMap>(
  session: SemiontSession,
  channel: K,
  payload: Record<string, unknown>,
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

  adapter.activeJob$.subscribe((job) => {
    if (!job) return;
    logger.info('Processing job', { jobId: job.jobId, type: job.type, resourceId: job.resourceId });
    handleJob(adapter, config, job).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Job failed', { jobId: job.jobId, error: message, stack: error instanceof Error ? error.stack : undefined });
      const failAnnotationId = (job.params as { referenceId?: string }).referenceId;
      emitEvent(session, 'job:fail', {
        resourceId: job.resourceId,
        userId: job.userId,
        jobId: job.jobId,
        jobType: job.type,
        ...(failAnnotationId ? { annotationId: failAnnotationId } : {}),
        error: message,
      }).catch(() => {});
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
): Promise<void> {
  const start = performance.now();
  let outcome: 'completed' | 'failed' = 'completed';
  try {
    return await withSpan(
      `job:${job.type}`,
      () => handleJobInner(adapter, config, job),
      {
        kind: SpanKind.CONSUMER,
        attrs: {
          'job.type': job.type,
          'job.id': job.jobId,
          'resource.id': job.resourceId as unknown as string,
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
): Promise<void> {
  const { session, inferenceClient, generator } = config;
  const { resourceId, userId, jobId, type: jobType } = job;

  // Annotation-scoped jobs (today: generation, triggered from a
  // reference) carry the source annotation through every lifecycle
  // payload so the UI can attach visual feedback to that annotation.
  // Resource-scoped jobs (bulk reference/tag/highlight/comment/
  // assessment detection scanning a whole resource) leave it unset.
  const annotationId = (job.params as { referenceId?: string }).referenceId;
  const lifecycleBase = {
    resourceId, userId, jobId, jobType,
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
  // detected span. Both come from the media-type registry's extraction strategy
  // (textExtractionOf, see prepareDetection): 'decode' -> decoded text + text
  // selectors, 'pdf-text-layer' -> extracted layer + viewrect selectors. Gating
  // on the strategy up front keeps binary bytes away from the model — a 'none'
  // type would TextDecoder-decode to mojibake. A scanned PDF (no text layer)
  // declines cleanly; a non-textual 'none' type is a user error and throws
  // (surfaces as job:fail via the startWorkerProcess catch). Generation reads the
  // annotation in its params, not the source bytes, so it is not prepared here.
  let source: Awaited<ReturnType<typeof prepareDetection>> = null;
  if (jobType !== 'generation') {
    const descriptor = await session.client.browse.resource(resourceId as never);
    const mediaType = getPrimaryMediaType(descriptor);
    const strategy = mediaType ? textExtractionOf(mediaType) : 'none';
    if (strategy === 'none') {
      throw new Error(`Cannot run ${jobType} on resource ${resourceId}: media type '${mediaType ?? 'unknown'}' has no extractable text to analyze`);
    }
    source = await prepareDetection(strategy, session, resourceId as ResourceId, userId, generator);
    if (!source) {
      // 'pdf-text-layer' that yielded no text layer: a scanned / image-only PDF.
      // Decline cleanly (not a crash) — complete the job with a no-text-layer result.
      await emitEvent(session, 'job:complete', {
        ...lifecycleBase,
        result: { declined: true, reason: 'no-text-layer', message: 'This PDF has no extractable text layer (scanned or image-only); detection is not supported.' } as never,
      });
      adapter.completeJob();
      return;
    }
  }

  const onProgress: OnProgress = (percentage, message, stage, extra) => {
    // Progress doubles as the worker's liveness heartbeat: it feeds the
    // stall watchdog here and refreshes the backend janitor's mtime
    // heartbeat via the job:report-progress mirror.
    adapter.touchActivity();
    emitEvent(session, 'job:report-progress', {
      ...lifecycleBase,
      percentage,
      progress: {
        stage, percentage, message,
        ...(annotationId ? { annotationId } : {}),
        ...(extra ?? {}),
      },
    }).catch(() => {});
  };

  if (jobType === 'highlight-annotation') {
    const { annotations, result } = await processHighlightJob(
      source!.text, inferenceClient, job.params as never, source!.buildAnnotation, onProgress,
    );
    for (const ann of annotations) {
      await emitEvent(session, 'mark:create', { annotation: ann, userId, resourceId });
    }
    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result: result as never,
    });
    adapter.completeJob();

  } else if (jobType === 'comment-annotation') {
    const { annotations, result } = await processCommentJob(
      source!.text, inferenceClient, job.params as never, source!.buildAnnotation, onProgress,
    );
    for (const ann of annotations) {
      await emitEvent(session, 'mark:create', { annotation: ann, userId, resourceId });
    }
    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result: result as never,
    });
    adapter.completeJob();

  } else if (jobType === 'assessment-annotation') {
    const { annotations, result } = await processAssessmentJob(
      source!.text, inferenceClient, job.params as never, source!.buildAnnotation, onProgress,
    );
    for (const ann of annotations) {
      await emitEvent(session, 'mark:create', { annotation: ann, userId, resourceId });
    }
    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result: result as never,
    });
    adapter.completeJob();

  } else if (jobType === 'reference-annotation') {
    const { annotations, result } = await processReferenceJob(
      source!.text, inferenceClient, job.params as never, source!.buildAnnotation, onProgress, config.logger,
    );
    for (const ann of annotations) {
      await emitEvent(session, 'mark:create', { annotation: ann, userId, resourceId });
    }
    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result: result as never,
    });
    adapter.completeJob();

  } else if (jobType === 'tag-annotation') {
    const { annotations, result } = await processTagJob(
      source!.text, inferenceClient, job.params as never, source!.buildAnnotation, onProgress,
    );
    for (const ann of annotations) {
      await emitEvent(session, 'mark:create', { annotation: ann, userId, resourceId });
    }
    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result: result as never,
    });
    adapter.completeJob();

  } else if (jobType === 'generation') {
    const genResult = await processGenerationJob(
      inferenceClient, job.params as never, onProgress, config.logger,
    );

    // Content never travels on the bus. Upload via the http-transport's
    // `client.yield.resource()` — same serializer the /know/compose
    // page uses, so the multipart wire shape has ONE definition.
    // The backend writes content to disk and emits `yield:create`
    // internally; we only learn the new resourceId from the response.
    const genParams = job.params as {
      referenceId?: string;
      prompt?: string;
      language?: string;
      entityTypes?: string[];
    };
    const storageUri = deriveStorageUri(genResult.title, genResult.format);

    const { resourceId: newResourceId } = await session.client.yield.resource({
      name: genResult.title,
      file: Buffer.from(genResult.content),
      format: genResult.format,
      storageUri,
      sourceResourceId: resourceId as unknown as string,
      ...(genParams.referenceId ? { sourceAnnotationId: genParams.referenceId } : {}),
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
    if (!genParams.referenceId) {
      const { annotation: provenanceRef } = assembleAnnotation(
        {
          motivation: 'linking',
          target: { source: String(resourceId) },
          body: { type: 'SpecificResource', source: String(newResourceId), purpose: 'linking' },
        },
        generator,
      );
      await emitEvent(session, 'mark:create', { annotation: provenanceRef, userId, resourceId });
    }

    // Inline citations (INLINE-CITATIONS P1): the processor resolved the model's
    // [[<id>]] transport tokens into claim-span citations against the final
    // (token-stripped) content. Mint each as a linking annotation ON THE DERIVED
    // resource — the target anchors the claim span, the body points at the cited
    // source — so citations are first-class references like any other.
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
      await emitEvent(session, 'mark:create', { annotation: citationRef, userId, resourceId: newResourceId });
    }

    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result: { resourceId: newResourceId, resourceName: genResult.title } as never,
    });
    adapter.completeJob();

  } else {
    adapter.failJob(jobId, `Unknown job type: ${jobType}`);
  }
}
