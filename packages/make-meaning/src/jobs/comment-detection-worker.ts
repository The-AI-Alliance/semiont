/**
 * Comment Detection Worker
 *
 * Processes comment-detection jobs: runs AI inference to identify passages
 * that would benefit from explanatory comments and creates comment annotations.
 */

import { JobWorker } from '@semiont/jobs';
import type { AnyJob, CommentDetectionJob, JobQueue, RunningJob, CommentDetectionParams, CommentDetectionProgress, CommentDetectionResult } from '@semiont/jobs';
import { ResourceContext, AnnotationDetection } from '..';
import { EventStore, generateAnnotationId } from '@semiont/event-sourcing';
import { resourceIdToURI, EventBus } from '@semiont/core';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { userId } from '@semiont/core';
import type { CommentMatch } from '../detection/motivation-parsers';
import type { InferenceClient } from '@semiont/inference';

export class CommentDetectionWorker extends JobWorker {
  private isFirstProgress = true;

  constructor(
    jobQueue: JobQueue,
    private config: EnvironmentConfig,
    private eventStore: EventStore,
    private inferenceClient: InferenceClient,
    private eventBus: EventBus
  ) {
    super(jobQueue);
  }

  protected getWorkerName(): string {
    return 'CommentDetectionWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'comment-detection';
  }

  protected async executeJob(job: AnyJob): Promise<CommentDetectionResult> {
    if (job.metadata.type !== 'comment-detection') {
      throw new Error(`Invalid job type: ${job.metadata.type}`);
    }

    // Type guard: job must be running to execute
    if (job.status !== 'running') {
      throw new Error(`Job must be in running state to execute, got: ${job.status}`);
    }

    // Reset progress tracking
    this.isFirstProgress = true;
    return await this.processCommentDetectionJob(job as RunningJob<CommentDetectionParams, CommentDetectionProgress>);
  }

  /**
   * Emit completion event with result data
   * Override base class to emit job.completed event
   */
  protected override async emitCompletionEvent(
    job: RunningJob<CommentDetectionParams, CommentDetectionProgress>,
    result: CommentDetectionResult
  ): Promise<void> {
    await this.eventStore.appendEvent({
      type: 'job.completed',
      resourceId: job.params.resourceId,
      userId: job.metadata.userId,
      version: 1,
      payload: {
        jobId: job.metadata.id,
        jobType: 'comment-detection',
        result,
      },
    });

    // Emit to EventBus for real-time subscribers
    // Domain event (job.completed) is automatically published to EventBus by EventStore
    // Backend SSE endpoint will subscribe to job.completed and transform to detect:finished
  }

  /**
   * Override updateJobProgress to emit events to Event Store
   */
  protected override async updateJobProgress(job: AnyJob): Promise<void> {
    // Call parent to update filesystem
    await super.updateJobProgress(job);

    if (job.metadata.type !== 'comment-detection') return;

    // Type guard: only running jobs have progress
    if (job.status !== 'running') {
      return;
    }

    const cdJob = job as RunningJob<CommentDetectionParams, CommentDetectionProgress>;

    const baseEvent = {
      resourceId: cdJob.params.resourceId,
      userId: cdJob.metadata.userId,
      version: 1,
    };

    const resourceBus = this.eventBus.scope(cdJob.params.resourceId);

    if (this.isFirstProgress) {
      // First progress update - emit job.started
      this.isFirstProgress = false;
      await this.eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: cdJob.metadata.id,
          jobType: cdJob.metadata.type,
        },
      });
    } else {
      // Intermediate progress - emit job.progress
      // Note: job.completed is now handled by emitCompletionEvent()
      await this.eventStore.appendEvent({
        type: 'job.progress',
        ...baseEvent,
        payload: {
          jobId: cdJob.metadata.id,
          jobType: cdJob.metadata.type,
          progress: cdJob.progress,
        },
      });
      resourceBus.get('detect:progress').next({
        status: cdJob.progress.stage,
        message: cdJob.progress.message,
        percentage: cdJob.progress.percentage
      });
    }
  }

  protected override async handleJobFailure(job: AnyJob, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, emit job.failed event
    if (job.status === 'failed' && job.metadata.type === 'comment-detection') {
      const cdJob = job as CommentDetectionJob;

      // Log the full error details to backend logs (already logged by parent)
      // Send generic error message to frontend
      await this.eventStore.appendEvent({
        type: 'job.failed',
        resourceId: cdJob.params.resourceId,
        userId: cdJob.metadata.userId,
        version: 1,
        payload: {
          jobId: cdJob.metadata.id,
          jobType: cdJob.metadata.type,
          error: 'Comment detection failed. Please try again later.',
        },
      });
    }
  }

  private async processCommentDetectionJob(job: RunningJob<CommentDetectionParams, CommentDetectionProgress>): Promise<CommentDetectionResult> {
    console.log(`[CommentDetectionWorker] Processing comment detection for resource ${job.params.resourceId} (job: ${job.metadata.id})`);

    // Fetch resource content
    const resource = await ResourceContext.getResourceMetadata(job.params.resourceId, this.config);

    if (!resource) {
      throw new Error(`Resource ${job.params.resourceId} not found`);
    }

    // Emit job.started and start analyzing
    let updatedJob: RunningJob<CommentDetectionParams, CommentDetectionProgress> = {
      ...job,
      progress: {
        stage: 'analyzing',
        percentage: 10,
        message: 'Loading resource...'
      }
    };
    await this.updateJobProgress(updatedJob);

    // Update progress
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'analyzing',
        percentage: 30,
        message: 'Analyzing text and generating comments...'
      }
    };
    await this.updateJobProgress(updatedJob);

    // Use AI to detect passages needing comments
    const comments = await AnnotationDetection.detectComments(
      job.params.resourceId,
      this.config,
      this.inferenceClient,
      job.params.instructions,
      job.params.tone,
      job.params.density
    );

    console.log(`[CommentDetectionWorker] Found ${comments.length} comments to create`);

    // Update progress
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'creating',
        percentage: 60,
        message: `Creating ${comments.length} annotations...`
      }
    };
    await this.updateJobProgress(updatedJob);

    // Create annotations for each comment
    let created = 0;
    for (const comment of comments) {
      try {
        await this.createCommentAnnotation(job.params.resourceId, job.metadata.userId, comment);
        created++;
      } catch (error) {
        console.error(`[CommentDetectionWorker] Failed to create comment:`, error);
      }
    }

    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'creating',
        percentage: 100,
        message: `Complete! Created ${created} comments`
      }
    };

    await this.updateJobProgress(updatedJob);
    console.log(`[CommentDetectionWorker] ✅ Created ${created}/${comments.length} comments`);

    // Return result - base class will use this for CompleteJob and emitCompletionEvent
    return {
      commentsFound: comments.length,
      commentsCreated: created
    };
  }

  private async createCommentAnnotation(
    resourceId: ResourceId,
    userId_: string,
    comment: CommentMatch
  ): Promise<void> {
    const backendUrl = this.config.services.backend?.publicURL;

    if (!backendUrl) {
      throw new Error('Backend publicURL not configured');
    }

    const resourceUri = resourceIdToURI(resourceId, backendUrl);
    const annotationId = generateAnnotationId(backendUrl);

    // Create W3C-compliant annotation with motivation: "commenting"
    const annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      type: 'Annotation' as const,
      id: annotationId,
      motivation: 'commenting' as const,
      target: {
        type: 'SpecificResource' as const,
        source: resourceUri,
        selector: [
          {
            type: 'TextPositionSelector' as const,
            start: comment.start,
            end: comment.end
          },
          {
            type: 'TextQuoteSelector' as const,
            exact: comment.exact,
            prefix: comment.prefix || '',
            suffix: comment.suffix || ''
          }
        ]
      },
      body: [
        {
          type: 'TextualBody' as const,
          value: comment.comment,
          purpose: 'commenting' as const,
          format: 'text/plain',
          language: 'en'
        }
      ]
    };

    // Append annotation.added event to Event Store
    await this.eventStore.appendEvent({
      type: 'annotation.added',
      resourceId,
      userId: userId(userId_),
      version: 1,
      payload: {
        annotation
      }
    });

    console.log(`[CommentDetectionWorker] Created comment annotation ${annotationId} for "${comment.exact.substring(0, 50)}..."`);
  }
}
