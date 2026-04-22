/**
 * Worker Process Entry Point
 *
 * Standalone Node process that uses WorkerVM to connect to a Knowledge
 * System over HTTP/SSE. Receives job assignments, processes them with
 * an inference provider, and emits domain events back to the KS.
 *
 * Usage:
 *   node worker-process.js
 *
 * The WorkerVM handles the reactive contract (SSE subscription, claim,
 * event emission). This file wires the job processors to the VM.
 */

import { createWorkerVM, type WorkerVM, type ActiveJob } from '@semiont/api-client';
import type { InferenceClient } from '@semiont/inference';
import type { Logger, components } from '@semiont/core';
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
  baseUrl: string;
  token: string;
  jobTypes: string[];
  inferenceClient: InferenceClient;
  generator: Agent;
  logger: Logger;
}

export function startWorkerProcess(config: WorkerProcessConfig): WorkerVM {
  const { logger } = config;
  const vm = createWorkerVM({
    baseUrl: config.baseUrl,
    token: config.token,
    jobTypes: config.jobTypes,
  });

  vm.activeJob$.subscribe((job) => {
    if (!job) return;
    logger.info('Processing job', { jobId: job.jobId, type: job.type, resourceId: job.resourceId });
    handleJob(vm, config, job).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Job failed', { jobId: job.jobId, error: message, stack: error instanceof Error ? error.stack : undefined });
      const failAnnotationId = (job.params as { referenceId?: string }).referenceId;
      vm.emitEvent('job:fail', {
        resourceId: job.resourceId,
        userId: job.userId,
        jobId: job.jobId,
        jobType: job.type,
        ...(failAnnotationId ? { annotationId: failAnnotationId } : {}),
        error: message,
      }).catch(() => {});
      vm.failJob(job.jobId, message);
    });
  });

  vm.start();
  return vm;
}

// Exported for unit testing — the orchestration (claim→fetch→process→emit→complete)
// is the only thing not otherwise exercised by processors.test.ts +
// worker-vm.test.ts. Do not call from outside the worker process.
export async function handleJob(vm: WorkerVM, config: WorkerProcessConfig, job: ActiveJob): Promise<void> {
  const { inferenceClient, generator } = config;
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

  await vm.emitEvent('job:start', lifecycleBase);

  const onProgress: OnProgress = (percentage, message, stage, extra) => {
    vm.emitEvent('job:report-progress', {
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
    const response = await fetch(`${config.baseUrl}/api/resources/${resourceId}`, {
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Accept': 'text/plain',
      },
    });
    if (!response.ok) throw new Error(`Failed to fetch content: ${response.status}`);
    return response.text();
  };

  if (jobType === 'highlight-annotation') {
    const content = await fetchContent();
    const { annotations, result } = await processHighlightJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
    );
    for (const ann of annotations) {
      await vm.emitEvent('mark:create', { annotation: ann, userId, resourceId });
    }
    await vm.emitEvent('job:complete', {
      ...lifecycleBase,
      result: result as never,
    });
    vm.completeJob();

  } else if (jobType === 'comment-annotation') {
    const content = await fetchContent();
    const { annotations, result } = await processCommentJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
    );
    for (const ann of annotations) {
      await vm.emitEvent('mark:create', { annotation: ann, userId, resourceId });
    }
    await vm.emitEvent('job:complete', {
      ...lifecycleBase,
      result: result as never,
    });
    vm.completeJob();

  } else if (jobType === 'assessment-annotation') {
    const content = await fetchContent();
    const { annotations, result } = await processAssessmentJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
    );
    for (const ann of annotations) {
      await vm.emitEvent('mark:create', { annotation: ann, userId, resourceId });
    }
    await vm.emitEvent('job:complete', {
      ...lifecycleBase,
      result: result as never,
    });
    vm.completeJob();

  } else if (jobType === 'reference-annotation') {
    const content = await fetchContent();
    const { annotations, result } = await processReferenceJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
    );
    for (const ann of annotations) {
      await vm.emitEvent('mark:create', { annotation: ann, userId, resourceId });
    }
    await vm.emitEvent('job:complete', {
      ...lifecycleBase,
      result: result as never,
    });
    vm.completeJob();

  } else if (jobType === 'tag-annotation') {
    const content = await fetchContent();
    const { annotations, result } = await processTagJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
    );
    for (const ann of annotations) {
      await vm.emitEvent('mark:create', { annotation: ann, userId, resourceId });
    }
    await vm.emitEvent('job:complete', {
      ...lifecycleBase,
      result: result as never,
    });
    vm.completeJob();

  } else if (jobType === 'generation') {
    const genResult = await processGenerationJob(
      inferenceClient, job.params as never, onProgress,
    );

    await vm.emitEvent('yield:create', {
      name: genResult.title,
      content: genResult.content,
      format: genResult.format,
      resourceId,
      referenceId: (job.params as { referenceId?: string }).referenceId,
    });

    // The generated resource's id is assigned by Stower when it
    // processes `yield:create` — the worker doesn't know it here.
    // Emit the name we do know; Stower fills in `resourceId` on the
    // persisted payload.
    await vm.emitEvent('job:complete', {
      ...lifecycleBase,
      result: { resourceName: genResult.title } as never,
    });
    vm.completeJob();

  } else {
    vm.failJob(jobId, `Unknown job type: ${jobType}`);
  }
}
