/**
 * Comment Detection Worker
 *
 * Processes comment-detection jobs: runs AI inference to identify passages
 * that would benefit from explanatory comments and creates comment annotations.
 */

import { JobWorker } from '../job-worker';
import type { AnyJob, CommentDetectionJob, RunningJob, CommentDetectionParams, CommentDetectionProgress, CommentDetectionResult, ContentFetcher } from '../types';
import type { JobQueue } from '../job-queue-interface';
import { AnnotationDetection } from './annotation-detection';
import { generateAnnotationId } from '@semiont/event-sourcing';
import { EventBus, userToAgent, type Logger, errField } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import { userId, jobId } from '@semiont/core';
import type { CommentMatch } from './detection/motivation-parsers';
import type { InferenceClient } from '@semiont/inference';
import type { components } from '@semiont/core';

type Agent = components['schemas']['Agent'];

export class CommentAnnotationWorker extends JobWorker {
  private isFirstProgress = true;

  constructor(
    jobQueue: JobQueue,
    private inferenceClient: InferenceClient,
    private generator: Agent,
    private eventBus: EventBus,
    private contentFetcher: ContentFetcher,
    logger: Logger
  ) {
    super(jobQueue, undefined, undefined, logger);
  }

  protected getWorkerName(): string {
    return 'CommentAnnotationWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'comment-annotation';
  }

  protected async executeJob(job: AnyJob): Promise<CommentDetectionResult> {
    if (job.metadata.type !== 'comment-annotation') {
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
   * Override base class to emit on EventBus
   */
  protected override async emitCompletionEvent(
    job: RunningJob<CommentDetectionParams, CommentDetectionProgress>,
    result: CommentDetectionResult
  ): Promise<void> {
    this.eventBus.get('job:complete').next({
      resourceId: job.params.resourceId,
      userId: userId(job.metadata.userId),
      jobId: jobId(job.metadata.id),
      jobType: 'comment-annotation',
      result,
    });

    // Emit mark:assist-finished on the resource-scoped bus so the events-stream
    // delivers it to all participants. Previously synthesized by the per-operation SSE route.
    const resourceBus = this.eventBus.scope(String(job.params.resourceId));
    resourceBus.get('mark:assist-finished').next({
      motivation: 'commenting',
      resourceId: String(job.params.resourceId),
      status: 'complete',
      percentage: 100,
      foundCount: result.commentsFound,
      createdCount: result.commentsCreated,
      message: 'Detection complete',
    });
  }

  /**
   * Override updateJobProgress to emit events via EventBus
   */
  protected override async updateJobProgress(job: AnyJob): Promise<void> {
    // Call parent to update filesystem
    await super.updateJobProgress(job);

    if (job.metadata.type !== 'comment-annotation') return;

    // Type guard: only running jobs have progress
    if (job.status !== 'running') {
      return;
    }

    const cdJob = job as RunningJob<CommentDetectionParams, CommentDetectionProgress>;

    if (this.isFirstProgress) {
      // First progress update - record job started
      this.isFirstProgress = false;
      this.eventBus.get('job:start').next({
        resourceId: cdJob.params.resourceId,
        userId: userId(cdJob.metadata.userId),
        jobId: jobId(cdJob.metadata.id),
        jobType: cdJob.metadata.type,
      });
    } else {
      // Intermediate progress - record job progress
      this.eventBus.get('job:report-progress').next({
        resourceId: cdJob.params.resourceId,
        userId: userId(cdJob.metadata.userId),
        jobId: jobId(cdJob.metadata.id),
        jobType: cdJob.metadata.type,
        percentage: cdJob.progress.percentage,
        progress: { stage: cdJob.progress.stage, percentage: cdJob.progress.percentage, message: cdJob.progress.message || '' },
      });
      // Ephemeral progress for real-time UI updates
      const resourceBus = this.eventBus.scope(cdJob.params.resourceId);
      resourceBus.get('mark:progress').next({
        status: cdJob.progress.stage,
        message: cdJob.progress.message,
        percentage: cdJob.progress.percentage
      });
    }
  }

  protected override async handleJobFailure(job: AnyJob, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, record via EventBus
    if (job.status === 'failed' && job.metadata.type === 'comment-annotation') {
      const cdJob = job as CommentDetectionJob;

      this.eventBus.get('job:fail').next({
        resourceId: cdJob.params.resourceId,
        userId: userId(cdJob.metadata.userId),
        jobId: jobId(cdJob.metadata.id),
        jobType: cdJob.metadata.type,
        error: 'Comment detection failed. Please try again later.',
      });

      // Emit mark:assist-failed on the resource-scoped bus
      const resourceBus = this.eventBus.scope(String(cdJob.params.resourceId));
      resourceBus.get('mark:assist-failed').next({
        resourceId: String(cdJob.params.resourceId),
        message: 'Comment detection failed. Please try again later.',
      });
    }
  }

  private async processCommentDetectionJob(job: RunningJob<CommentDetectionParams, CommentDetectionProgress>): Promise<CommentDetectionResult> {
    this.logger?.info('Processing comment detection job', {
      resourceId: job.params.resourceId,
      jobId: job.metadata.id
    });

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

    // Fetch content via ContentFetcher
    const content = await AnnotationDetection.fetchContent(this.contentFetcher, job.params.resourceId);

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
      content,
      this.inferenceClient,
      job.params.instructions,
      job.params.tone,
      job.params.density
    );

    this.logger?.info('Found comments to create', { count: comments.length });

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
        await this.createCommentAnnotation(job.params.resourceId, job.metadata, comment, job.params.language);
        created++;
      } catch (error) {
        this.logger?.error('Failed to create comment', { error: errField(error) });
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
    this.logger?.info('Comment detection complete', { created, total: comments.length });

    // Return result - base class will use this for CompleteJob and emitCompletionEvent
    return {
      commentsFound: comments.length,
      commentsCreated: created
    };
  }

  private async createCommentAnnotation(
    resourceId: ResourceId,
    metadata: import('../types').JobMetadata,
    comment: CommentMatch,
    language?: string
  ): Promise<void> {
    const annotationIdVal = generateAnnotationId();

    const creator = userToAgent({
      id: metadata.userId,
      name: metadata.userName,
      email: metadata.userEmail,
      domain: metadata.userDomain,
    });

    // Create W3C-compliant annotation with motivation: "commenting"
    const annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      type: 'Annotation' as const,
      id: annotationIdVal,
      motivation: 'commenting' as const,
      creator,
      generator: this.generator,
      created: new Date().toISOString(),
      target: {
        type: 'SpecificResource' as const,
        source: resourceId as string,
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
          language: language || 'en'
        }
      ]
    };

    this.eventBus.get('mark:create').next({
      annotation,
      userId: userId(metadata.userId),
      resourceId,
    });

    this.logger?.debug('Created comment annotation', {
      annotationId: annotationIdVal,
      exactPreview: comment.exact.substring(0, 50)
    });
  }
}
