/**
 * Generation Worker
 *
 * Processes generation jobs: runs AI inference to generate new resources
 * and emits events on the EventBus for all writes.
 *
 * This worker is INDEPENDENT of HTTP clients - it just processes jobs and
 * emits events on the EventBus for all writes.
 */

import { JobWorker } from '../job-worker';
import type { AnyJob, RunningJob, GenerationParams, YieldProgress, GenerationResult, GenerationJob } from '../types';
import type { JobQueue } from '../job-queue';
import { generateResourceFromTopic } from './generation/resource-generation';
import { EventBus, type Logger } from '@semiont/core';
import { getTargetSelector, getExactText } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/ontology';
import {
  CREATION_METHODS,
  type BodyOperation,
  annotationId,
  userId,
  jobId,
} from '@semiont/core';

import type { InferenceClient } from '@semiont/inference';
import { firstValueFrom, race, timer } from 'rxjs';
import { map, take } from 'rxjs/operators';

export class GenerationWorker extends JobWorker {
  constructor(
    jobQueue: JobQueue,
    private inferenceClient: InferenceClient,
    private eventBus: EventBus,
    logger: Logger
  ) {
    super(jobQueue, undefined, undefined, logger);
  }

  protected getWorkerName(): string {
    return 'GenerationWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'generation';
  }

  protected async executeJob(job: AnyJob): Promise<GenerationResult> {
    if (job.metadata.type !== 'generation') {
      throw new Error(`Invalid job type: ${job.metadata.type}`);
    }

    // Type guard: job must be running to execute
    if (job.status !== 'running') {
      throw new Error(`Job must be in running state to execute, got: ${job.status}`);
    }

    return await this.processGenerationJob(job as RunningJob<GenerationParams, YieldProgress>);
  }

  private async processGenerationJob(job: RunningJob<GenerationParams, YieldProgress>): Promise<GenerationResult> {
    this.logger?.info('Processing generation job', {
      referenceId: job.params.referenceId,
      jobId: job.metadata.id
    });

    // Update progress: fetching
    let updatedJob: RunningJob<GenerationParams, YieldProgress> = {
      ...job,
      progress: {
        stage: 'fetching',
        percentage: 20,
        message: 'Fetching source resource...'
      }
    };
    this.logger?.debug('Generation progress', { stage: updatedJob.progress.stage, message: updatedJob.progress.message });
    await this.updateJobProgress(updatedJob);

    // Annotation is passed in job params (bus-only: no view storage reads)
    const annotation = job.params.annotation;

    // Determine resource name
    const targetSelector = getTargetSelector(annotation.target);
    const resourceName = job.params.title || (targetSelector ? getExactText(targetSelector) : '') || 'New Resource';
    this.logger?.info('Generating resource', { resourceName });

    // Verify context is provided (required for generation)
    if (!job.params.context) {
      throw new Error('Generation context is required but was not provided in job');
    }
    this.logger?.debug('Using pre-fetched context', {
      beforeLength: job.params.context.sourceContext?.before?.length || 0,
      selectedLength: job.params.context.sourceContext?.selected?.length || 0,
      afterLength: job.params.context.sourceContext?.after?.length || 0
    });

    // Update progress: generating (skip fetching context since it's already in job)
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'generating',
        percentage: 40,
        message: 'Creating content with AI...'
      }
    };
    this.logger?.debug('Generation progress', { stage: updatedJob.progress.stage, message: updatedJob.progress.message });
    await this.updateJobProgress(updatedJob);

    // Generate content using AI with context from job
    const prompt = job.params.prompt || `Create a comprehensive resource about "${resourceName}"`;
    // Extract entity types from annotation body
    const annotationEntityTypes = getEntityTypes({ body: annotation.body });

    const generatedContent = await generateResourceFromTopic(
      resourceName,
      job.params.entityTypes || annotationEntityTypes,
      this.inferenceClient,
      prompt,
      job.params.language,
      job.params.context,
      job.params.temperature,
      job.params.maxTokens
    );

    this.logger?.info('Content generated', { contentLength: generatedContent.content.length });

    // Update progress: creating
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'generating',
        percentage: 70,
        message: 'Content ready, creating resource...'
      }
    };
    await this.updateJobProgress(updatedJob);

    // Update progress: creating
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'creating',
        percentage: 85,
        message: 'Saving resource...'
      }
    };
    this.logger?.debug('Generation progress', { stage: updatedJob.progress.stage, message: updatedJob.progress.message });
    await this.updateJobProgress(updatedJob);

    // Create resource via EventBus
    const createParams = {
      name: resourceName,
      content: Buffer.from(generatedContent.content),
      format: 'text/markdown' as const,
      userId: userId(job.metadata.userId),
      entityTypes: job.params.entityTypes || annotationEntityTypes,
      language: job.params.language,
      creationMethod: CREATION_METHODS.GENERATED,
      isDraft: true,
      generatedFrom: job.params.referenceId,
      storageUri: job.params.storageUri,
    };

    const result$ = race(
      this.eventBus.get('yield:created').pipe(take(1), map(r => ({ ok: true as const, result: r }))),
      this.eventBus.get('yield:create-failed').pipe(take(1), map(f => ({ ok: false as const, error: f.error }))),
      timer(30_000).pipe(map(() => ({ ok: false as const, error: new Error('Resource creation timed out') }))),
    );
    this.eventBus.get('yield:create').next(createParams);
    const outcome = await firstValueFrom(result$);
    if (!outcome.ok) throw outcome.error;
    const rId = outcome.result.resourceId;
    this.logger?.info('Resource created via EventBus', { resourceId: rId });

    // Update progress: linking
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'linking',
        percentage: 95,
        message: 'Linking reference...'
      }
    };
    this.logger?.debug('Generation progress', { stage: updatedJob.progress.stage, message: updatedJob.progress.message });
    await this.updateJobProgress(updatedJob);

    // Update annotation body to link the annotation to the new resource
    const operations: BodyOperation[] = [{
      op: 'add',
      item: {
        type: 'SpecificResource',
        source: rId as string,
        purpose: 'linking',
      },
    }];

    this.eventBus.get('mark:update-body').next({
      annotationId: annotationId(job.params.referenceId),
      userId: userId(job.metadata.userId),
      resourceId: job.params.sourceResourceId,
      operations,
    });
    this.logger?.info('Updated annotation body via EventBus', {
      referenceId: job.params.referenceId,
      targetResourceId: rId
    });

    // Final progress update
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'linking',
        percentage: 100,
        message: 'Complete!'
      }
    };
    await this.updateJobProgress(updatedJob);

    this.logger?.info('Generation complete', { createdResourceId: rId });

    // Return result - base class will use this for CompleteJob and emitCompletionEvent
    return {
      resourceId: rId,
      resourceName: resourceName
    };
  }

  /**
   * Emit completion event with result data
   * Override base class to emit on EventBus
   */
  protected override async emitCompletionEvent(
    job: RunningJob<GenerationParams, YieldProgress>,
    result: GenerationResult
  ): Promise<void> {
    this.eventBus.get('job:complete').next({
      resourceId: job.params.sourceResourceId,
      userId: userId(job.metadata.userId),
      jobId: jobId(job.metadata.id),
      jobType: 'generation',
      result: {
        resultResourceId: result.resourceId,
        annotationId: job.params.referenceId,
      },
    });
  }

  protected override async handleJobFailure(job: AnyJob, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, record via EventBus
    if (job.status === 'failed' && job.metadata.type === 'generation') {
      const genJob = job as GenerationJob;

      this.eventBus.get('job:fail').next({
        resourceId: genJob.params.sourceResourceId,
        userId: userId(genJob.metadata.userId),
        jobId: jobId(genJob.metadata.id),
        jobType: genJob.metadata.type,
        error: 'Resource generation failed. Please try again later.',
      });
    }
  }

  /**
   * Update job progress and emit ephemeral events via EventBus
   * Overrides base class to emit job lifecycle events and yield:progress events
   */
  protected override async updateJobProgress(job: AnyJob): Promise<void> {
    // Call parent to update job queue
    await super.updateJobProgress(job);

    // Emit events for generation jobs
    if (job.metadata.type !== 'generation') {
      return;
    }

    // Type guard: only running jobs have progress
    if (job.status !== 'running') {
      return;
    }

    const genJob = job as RunningJob<GenerationParams, YieldProgress>;

    const resourceBus = this.eventBus.scope(genJob.params.sourceResourceId);

    // Emit appropriate event based on progress stage
    if (genJob.progress.stage === 'fetching' && genJob.progress.percentage === 20) {
      // First progress update - record job started via EventBus
      this.eventBus.get('job:start').next({
        resourceId: genJob.params.sourceResourceId,
        userId: userId(genJob.metadata.userId),
        jobId: jobId(genJob.metadata.id),
        jobType: genJob.metadata.type,
      });
    } else {
      // Intermediate progress - record via EventBus
      this.eventBus.get('job:report-progress').next({
        resourceId: genJob.params.sourceResourceId,
        userId: userId(genJob.metadata.userId),
        jobId: jobId(genJob.metadata.id),
        jobType: genJob.metadata.type,
        percentage: genJob.progress.percentage,
        progress: {
          currentStep: genJob.progress.stage,
          message: genJob.progress.message,
        },
      });
      resourceBus.get('yield:progress').next({
        status: genJob.progress.stage as 'fetching' | 'generating' | 'creating',
        referenceId: genJob.params.referenceId,
        sourceResourceId: genJob.params.sourceResourceId,
        percentage: genJob.progress.percentage,
        message: genJob.progress.message
      });
    }
  }
}
