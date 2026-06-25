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
import type { Logger, components } from '@semiont/core';
import { deriveStorageUri } from '@semiont/content';
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

  // Detection jobs decode the source resource as text — fetchContent()
  // sends Accept: text/plain and TextDecoder-decodes whatever returns —
  // so gate on the registry's extraction strategy before fetching:
  // binary types have no text to analyze (the LLM would see mojibake),
  // and PDFs need the text-layer path that arrives with PDF-DETECTION.md.
  // Generation reads the annotation carried in its params, not the
  // source bytes, so it is not gated. Throwing here surfaces as a normal
  // job:fail through the startWorkerProcess catch.
  if (jobType !== 'generation') {
    const descriptor = await session.client.browse.resource(resourceId as never);
    const mediaType = getPrimaryMediaType(descriptor);
    const extraction = mediaType ? textExtractionOf(mediaType) : 'none';
    if (extraction === 'pdf-text-layer') {
      throw new Error(`Cannot run ${jobType} on resource ${resourceId}: PDF text-layer detection is not yet supported`);
    }
    if (extraction !== 'decode') {
      throw new Error(`Cannot run ${jobType} on resource ${resourceId}: media type '${mediaType ?? 'unknown'}' has no extractable text to analyze`);
    }
  }

  const onProgress: OnProgress = (percentage, message, stage, extra) => {
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

  const fetchContent = async (): Promise<string> => {
    return session.client.browse.resourceContent(resourceId as never);
  };

  if (jobType === 'highlight-annotation') {
    const content = await fetchContent();
    const { annotations, result } = await processHighlightJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
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
    const content = await fetchContent();
    const { annotations, result } = await processCommentJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
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
    const content = await fetchContent();
    const { annotations, result } = await processAssessmentJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
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
    const content = await fetchContent();
    const { annotations, result } = await processReferenceJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress, config.logger,
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
    const content = await fetchContent();
    const { annotations, result } = await processTagJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
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

    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result: { resourceId: newResourceId, resourceName: genResult.title } as never,
    });
    adapter.completeJob();

  } else {
    adapter.failJob(jobId, `Unknown job type: ${jobType}`);
  }
}
