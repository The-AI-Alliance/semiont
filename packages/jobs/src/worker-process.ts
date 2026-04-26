/**
 * Worker Process Entry Point
 *
 * Standalone Node process that hangs a job-claim loop off a
 * `SemiontSession`'s transport. Receives job assignments, processes them
 * with an inference provider, and emits domain events through
 * `session.client.transport.emit`. All HTTP and SSE goes through the
 * api-client — no raw `fetch`, no hand-rolled multipart.
 *
 * Workers are inherently bound to HTTP transport (they connect to a
 * remote backend over the wire). The cast to `HttpTransport` to reach
 * the underlying `ActorVM` for `JobClaimAdapter` reflects that — local
 * workers don't make sense.
 *
 * Usage:
 *   node worker-process.js
 *
 * `createJobClaimAdapter` handles the reactive contract (SSE
 * subscription, claim, completion tracking). This file wires the
 * job processors to the adapter and drives lifecycle emissions.
 */

import { createJobClaimAdapter, type JobClaimAdapter, type ActiveJob, type SemiontSession } from '@semiont/sdk';
import { type HttpTransport } from '@semiont/api-client';
import { RESOURCE_BROADCAST_TYPES, resourceId as makeResourceId, type EventMap } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import type { Logger, components } from '@semiont/core';
import { deriveStorageUri } from '@semiont/content';
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

export interface WorkerEngine {
  inferenceClient: InferenceClient;
  generator: Agent;
}

export interface WorkerProcessConfig {
  session: SemiontSession;
  jobTypes: string[];
  /**
   * Per-job-type inference client + generator metadata. Keyed by the
   * job type the worker has subscribed to (`jobTypes`). Each entry lets
   * that job type run on its own model, as configured in
   * `[workers.<job-type>.inference]`.
   */
  engines: Record<string, WorkerEngine>;
  logger: Logger;
}

/**
 * Route `transport.emit` calls — choosing resource-scoped vs global based
 * on whether the event is a cross-subscriber broadcast. Extracted
 * from the deleted `WorkerVM.emitEvent`; kept here as a module-level
 * helper because `handleJob` uses it a dozen times.
 */
async function emitEvent<K extends keyof EventMap>(
  session: SemiontSession,
  channel: K,
  payload: Record<string, unknown>,
): Promise<void> {
  const isBroadcast = (RESOURCE_BROADCAST_TYPES as readonly string[]).includes(channel as string);
  const rawScope = isBroadcast ? ((payload as { resourceId?: string }).resourceId) : undefined;
  const resourceScope = rawScope ? makeResourceId(rawScope) : undefined;
  await session.client.transport.emit(channel, payload as EventMap[K], resourceScope);
}

export function startWorkerProcess(config: WorkerProcessConfig): JobClaimAdapter {
  const { session, logger } = config;
  // Workers are HTTP-bound; the actor is needed for the job-claim
  // protocol (SSE subscribe + ad-hoc channel adds). Cast to HttpTransport
  // is intentional: `LocalTransport` workers don't exist.
  const httpTransport = session.client.transport as HttpTransport;
  const adapter = createJobClaimAdapter({
    actor: httpTransport.actor,
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
  const { session } = config;
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

  const engine = config.engines[jobType];
  if (!engine) {
    adapter.failJob(jobId, `No inference engine configured for job type: ${jobType}`);
    return;
  }
  const { inferenceClient, generator } = engine;

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
      inferenceClient, job.params as never, onProgress,
    );

    // Content never travels on the bus. Upload via the api-client's
    // `client.yield.resource()` — same serializer the /know/compose
    // page uses, so the multipart wire shape has ONE definition.
    // The backend writes content to disk and emits `yield:create`
    // internally; we only learn the new resourceId from the response.
    const genParams = job.params as {
      referenceId?: string;
      prompt?: string;
      language?: string;
    };
    const storageUri = deriveStorageUri(genResult.title, genResult.format);

    const { resourceId: newResourceId } = await session.client.yield.resource({
      name: genResult.title,
      file: Buffer.from(genResult.content),
      format: genResult.format,
      storageUri,
      creationMethod: 'generated',
      sourceResourceId: resourceId as unknown as string,
      ...(genParams.referenceId ? { sourceAnnotationId: genParams.referenceId } : {}),
      ...(genParams.prompt ? { generationPrompt: genParams.prompt } : {}),
      ...(genParams.language ? { language: genParams.language } : {}),
      generator,
    });

    await emitEvent(session, 'job:complete', {
      ...lifecycleBase,
      result: { resourceId: newResourceId, resourceName: genResult.title } as never,
    });
    adapter.completeJob();

  } else {
    adapter.failJob(jobId, `Unknown job type: ${jobType}`);
  }
}
