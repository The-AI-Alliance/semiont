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
      vm.emitEvent('mark:assist-failed', {
        resourceId: job.resourceId,
        message,
      }).catch(() => {});
      vm.failJob(job.jobId, message);
    });
  });

  vm.start();
  return vm;
}

async function handleJob(vm: WorkerVM, config: WorkerProcessConfig, job: ActiveJob): Promise<void> {
  const { inferenceClient, generator } = config;
  const resourceId = job.resourceId;
  const userId = job.userId;


  const onProgress: OnProgress = (percentage, message, stage) => {
    vm.emitEvent('mark:progress', {
      resourceId,
      status: stage,
      percentage,
      message,
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

  if (job.type === 'highlight-annotation') {
    const content = await fetchContent();
    const { annotations, result } = await processHighlightJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
    );
    for (const ann of annotations) {
      await vm.emitEvent('mark:create', { annotation: ann, userId, resourceId });
    }
    await vm.emitEvent('mark:assist-finished', {
      motivation: 'highlighting', resourceId, status: 'complete', percentage: 100,
      foundCount: result.highlightsFound, createdCount: result.highlightsCreated,
      message: 'Detection complete',
    });
    vm.completeJob();

  } else if (job.type === 'comment-annotation') {
    const content = await fetchContent();
    const { annotations, result } = await processCommentJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
    );
    for (const ann of annotations) {
      await vm.emitEvent('mark:create', { annotation: ann, userId, resourceId });
    }
    await vm.emitEvent('mark:assist-finished', {
      motivation: 'commenting', resourceId, status: 'complete', percentage: 100,
      foundCount: result.commentsFound, createdCount: result.commentsCreated,
      message: 'Detection complete',
    });
    vm.completeJob();

  } else if (job.type === 'assessment-annotation') {
    const content = await fetchContent();
    const { annotations, result } = await processAssessmentJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
    );
    for (const ann of annotations) {
      await vm.emitEvent('mark:create', { annotation: ann, userId, resourceId });
    }
    await vm.emitEvent('mark:assist-finished', {
      motivation: 'assessing', resourceId, status: 'complete', percentage: 100,
      foundCount: result.assessmentsFound, createdCount: result.assessmentsCreated,
      message: 'Detection complete',
    });
    vm.completeJob();

  } else if (job.type === 'reference-annotation') {
    const content = await fetchContent();
    const { annotations, result } = await processReferenceJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
    );
    for (const ann of annotations) {
      await vm.emitEvent('mark:create', { annotation: ann, userId, resourceId });
    }
    await vm.emitEvent('mark:assist-finished', {
      motivation: 'linking', resourceId, status: 'complete', percentage: 100,
      foundCount: result.totalFound, createdCount: result.totalEmitted,
      message: 'Detection complete',
    });
    vm.completeJob();

  } else if (job.type === 'tag-annotation') {
    const content = await fetchContent();
    const { annotations, result } = await processTagJob(
      content, inferenceClient, job.params as never, userId, generator, onProgress,
    );
    for (const ann of annotations) {
      await vm.emitEvent('mark:create', { annotation: ann, userId, resourceId });
    }
    await vm.emitEvent('mark:assist-finished', {
      motivation: 'tagging', resourceId, status: 'complete', percentage: 100,
      foundCount: result.tagsFound, createdCount: result.tagsCreated,
      message: 'Detection complete',
    });
    vm.completeJob();

  } else if (job.type === 'generation') {
    const yieldProgress: OnProgress = (percentage, message, stage) => {
      vm.emitEvent('yield:progress', {
        referenceId: (job.params as { referenceId?: string }).referenceId ?? '',
        sourceResourceId: resourceId,
        status: stage,
        percentage,
        message,
      }).catch(() => {});
    };

    const genResult = await processGenerationJob(
      inferenceClient, job.params as never, yieldProgress,
    );

    await vm.emitEvent('yield:create', {
      name: genResult.title,
      content: genResult.content,
      format: genResult.format,
      resourceId,
      referenceId: (job.params as { referenceId?: string }).referenceId,
    });

    vm.completeJob();

  } else {
    vm.failJob(job.jobId, `Unknown job type: ${job.type}`);
  }
}
