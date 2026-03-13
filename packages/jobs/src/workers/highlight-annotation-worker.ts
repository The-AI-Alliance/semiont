/**
 * Highlight Detection Worker
 *
 * Processes highlight-detection jobs: runs AI inference to find passages
 * that should be highlighted and creates highlight annotations.
 */

import { JobWorker } from '../job-worker';
import type { AnyJob, HighlightDetectionJob, RunningJob, HighlightDetectionParams, HighlightDetectionProgress, HighlightDetectionResult, ContentFetcher } from '../types';
import type { JobQueue } from '../job-queue';
import { AnnotationDetection } from './annotation-detection';
import { generateAnnotationId } from '@semiont/event-sourcing';
import { EventBus, userToAgent, type Logger } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import { userId, jobId } from '@semiont/core';
import type { HighlightMatch } from './detection/motivation-parsers';
import type { InferenceClient } from '@semiont/inference';

export class HighlightAnnotationWorker extends JobWorker {
  private isFirstProgress = true;

  constructor(
    jobQueue: JobQueue,
    private inferenceClient: InferenceClient,
    private eventBus: EventBus,
    private contentFetcher: ContentFetcher,
    logger: Logger
  ) {
    super(jobQueue, undefined, undefined, logger);
  }

  protected getWorkerName(): string {
    return 'HighlightAnnotationWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'highlight-annotation';
  }

  protected async executeJob(job: AnyJob): Promise<HighlightDetectionResult> {
    if (job.metadata.type !== 'highlight-annotation') {
      throw new Error(`Invalid job type: ${job.metadata.type}`);
    }

    // Type guard: job must be running to execute
    if (job.status !== 'running') {
      throw new Error(`Job must be in running state to execute, got: ${job.status}`);
    }

    // Reset progress tracking
    this.isFirstProgress = true;
    return await this.processHighlightDetectionJob(job as RunningJob<HighlightDetectionParams, HighlightDetectionProgress>);
  }

  /**
   * Emit completion event with result data
   * Override base class to emit on EventBus
   */
  protected override async emitCompletionEvent(
    job: RunningJob<HighlightDetectionParams, HighlightDetectionProgress>,
    result: HighlightDetectionResult
  ): Promise<void> {
    this.eventBus.get('job:complete').next({
      resourceId: job.params.resourceId,
      userId: userId(job.metadata.userId),
      jobId: jobId(job.metadata.id),
      jobType: 'highlight-annotation',
      result: { result },
    });
  }

  /**
   * Override updateJobProgress to emit events via EventBus
   */
  protected override async updateJobProgress(job: AnyJob): Promise<void> {
    // Call parent to update filesystem
    await super.updateJobProgress(job);

    if (job.metadata.type !== 'highlight-annotation') return;

    // Type guard: only running jobs have progress
    if (job.status !== 'running') {
      return;
    }

    const hlJob = job as RunningJob<HighlightDetectionParams, HighlightDetectionProgress>;

    if (this.isFirstProgress) {
      // First progress update - record job started
      this.isFirstProgress = false;
      this.eventBus.get('job:start').next({
        resourceId: hlJob.params.resourceId,
        userId: userId(hlJob.metadata.userId),
        jobId: jobId(hlJob.metadata.id),
        jobType: hlJob.metadata.type,
      });
    } else {
      // Intermediate progress - record job progress
      this.eventBus.get('job:report-progress').next({
        resourceId: hlJob.params.resourceId,
        userId: userId(hlJob.metadata.userId),
        jobId: jobId(hlJob.metadata.id),
        jobType: hlJob.metadata.type,
        percentage: hlJob.progress.percentage,
        progress: { progress: hlJob.progress },
      });
      // Ephemeral progress for real-time UI updates
      const resourceBus = this.eventBus.scope(hlJob.params.resourceId);
      resourceBus.get('mark:progress').next({
        status: hlJob.progress.stage,
        message: hlJob.progress.message,
        percentage: hlJob.progress.percentage
      });
    }
  }

  protected override async handleJobFailure(job: AnyJob, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, record via EventBus
    if (job.status === 'failed' && job.metadata.type === 'highlight-annotation') {
      const hlJob = job as HighlightDetectionJob;

      this.eventBus.get('job:fail').next({
        resourceId: hlJob.params.resourceId,
        userId: userId(hlJob.metadata.userId),
        jobId: jobId(hlJob.metadata.id),
        jobType: hlJob.metadata.type,
        error: 'Highlight detection failed. Please try again later.',
      });
    }
  }

  private async processHighlightDetectionJob(job: RunningJob<HighlightDetectionParams, HighlightDetectionProgress>): Promise<HighlightDetectionResult> {
    this.logger?.info('Processing highlight detection job', {
      resourceId: job.params.resourceId,
      jobId: job.metadata.id
    });

    // Emit job.started and start analyzing
    let updatedJob: RunningJob<HighlightDetectionParams, HighlightDetectionProgress> = {
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
        message: 'Analyzing text...'
      }
    };
    await this.updateJobProgress(updatedJob);

    // Use AI to detect highlights
    const highlights = await AnnotationDetection.detectHighlights(
      content,
      this.inferenceClient,
      job.params.instructions,
      job.params.density
    );

    this.logger?.info('Found highlights to create', { count: highlights.length });

    // Update progress
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'creating',
        percentage: 60,
        message: `Creating ${highlights.length} annotations...`
      }
    };
    await this.updateJobProgress(updatedJob);

    // Create annotations for each highlight
    let created = 0;
    for (const highlight of highlights) {
      try {
        await this.createHighlightAnnotation(job.params.resourceId, job.metadata, highlight);
        created++;
      } catch (error) {
        this.logger?.error('Failed to create highlight', { error });
      }
    }

    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'creating',
        percentage: 100,
        message: `Complete! Created ${created} highlights`
      }
    };

    await this.updateJobProgress(updatedJob);
    this.logger?.info('Highlight detection complete', { created, total: highlights.length });

    // Return result - base class will use this for CompleteJob and emitCompletionEvent
    return {
      highlightsFound: highlights.length,
      highlightsCreated: created
    };
  }

  private async createHighlightAnnotation(
    resourceId: ResourceId,
    metadata: import('../types').JobMetadata,
    highlight: HighlightMatch
  ): Promise<void> {
    const annotationIdVal = generateAnnotationId();

    const creator = userToAgent({
      id: metadata.userId,
      name: metadata.userName,
      email: metadata.userEmail,
      domain: metadata.userDomain,
    });

    // Create W3C annotation with motivation: highlighting
    // Use both TextPositionSelector and TextQuoteSelector (with prefix/suffix for fuzzy anchoring)
    const annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      'id': annotationIdVal,
      'motivation': 'highlighting' as const,
      creator,
      created: new Date().toISOString(),
      'target': {
        type: 'SpecificResource' as const,
        source: resourceId as string,
        selector: [
          {
            type: 'TextPositionSelector' as const,
            start: highlight.start,
            end: highlight.end,
          },
          {
            type: 'TextQuoteSelector' as const,
            exact: highlight.exact,
            ...(highlight.prefix && { prefix: highlight.prefix }),
            ...(highlight.suffix && { suffix: highlight.suffix }),
          },
        ]
      },
      'body': []  // Empty body for highlights
    };

    this.eventBus.get('mark:create').next({
      annotation,
      userId: userId(metadata.userId),
      resourceId,
    });
  }
}
