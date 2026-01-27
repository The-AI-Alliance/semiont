/**
 * Highlight Detection Worker
 *
 * Processes highlight-detection jobs: runs AI inference to find passages
 * that should be highlighted and creates highlight annotations.
 */

import { JobWorker } from '@semiont/jobs';
import type { AnyJob, HighlightDetectionJob, JobQueue, RunningJob, HighlightDetectionParams, HighlightDetectionProgress } from '@semiont/jobs';
import { ResourceContext, AnnotationDetection } from '../..';
import { EventStore, generateAnnotationId } from '@semiont/event-sourcing';
import { resourceIdToURI } from '@semiont/core';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { userId } from '@semiont/core';
import type { HighlightMatch } from '@semiont/inference';

export class HighlightDetectionWorker extends JobWorker {
  private isFirstProgress = true;

  constructor(
    jobQueue: JobQueue,
    private config: EnvironmentConfig,
    private eventStore: EventStore
  ) {
    super(jobQueue);
  }

  protected getWorkerName(): string {
    return 'HighlightDetectionWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'highlight-detection';
  }

  protected async executeJob(job: AnyJob): Promise<void> {
    if (job.metadata.type !== 'highlight-detection') {
      throw new Error(`Invalid job type: ${job.metadata.type}`);
    }

    // Type guard: job must be running to execute
    if (job.status !== 'running') {
      throw new Error(`Job must be in running state to execute, got: ${job.status}`);
    }

    // Reset progress tracking
    this.isFirstProgress = true;
    await this.processHighlightDetectionJob(job as RunningJob<HighlightDetectionParams, HighlightDetectionProgress>);
  }

  /**
   * Override updateJobProgress to emit events to Event Store
   */
  protected override async updateJobProgress(job: AnyJob): Promise<void> {
    // Call parent to update filesystem
    await super.updateJobProgress(job);

    if (job.metadata.type !== 'highlight-detection') return;

    // Type guard: only running jobs have progress
    if (job.status !== 'running') {
      return;
    }

    const hlJob = job as RunningJob<HighlightDetectionParams, HighlightDetectionProgress>;

    const baseEvent = {
      resourceId: hlJob.params.resourceId,
      userId: hlJob.metadata.userId,
      version: 1,
    };

    // Determine if this is completion (100% and has result)
    const isComplete = hlJob.progress.percentage === 100;

    if (this.isFirstProgress) {
      // First progress update - emit job.started
      this.isFirstProgress = false;
      await this.eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: hlJob.metadata.id,
          jobType: hlJob.metadata.type,
        },
      });
    } else if (isComplete) {
      // Final update - emit job.completed
      await this.eventStore.appendEvent({
        type: 'job.completed',
        ...baseEvent,
        payload: {
          jobId: hlJob.metadata.id,
          jobType: hlJob.metadata.type,
          // Note: result would come from job.result, but that's handled by base class
        },
      });
    } else {
      // Intermediate progress - emit job.progress
      await this.eventStore.appendEvent({
        type: 'job.progress',
        ...baseEvent,
        payload: {
          jobId: hlJob.metadata.id,
          jobType: hlJob.metadata.type,
          progress: hlJob.progress,
        },
      });
    }
  }

  protected override async handleJobFailure(job: AnyJob, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, emit job.failed event
    if (job.status === 'failed' && job.metadata.type === 'highlight-detection') {
      const hlJob = job as HighlightDetectionJob;

      // Log the full error details to backend logs (already logged by parent)
      // Send generic error message to frontend
      await this.eventStore.appendEvent({
        type: 'job.failed',
        resourceId: hlJob.params.resourceId,
        userId: hlJob.metadata.userId,
        version: 1,
        payload: {
          jobId: hlJob.metadata.id,
          jobType: hlJob.metadata.type,
          error: 'Highlight detection failed. Please try again later.',
        },
      });
    }
  }

  private async processHighlightDetectionJob(job: RunningJob<HighlightDetectionParams, HighlightDetectionProgress>): Promise<void> {
    console.log(`[HighlightDetectionWorker] Processing highlight detection for resource ${job.params.resourceId} (job: ${job.metadata.id})`);

    // Fetch resource content
    const resource = await ResourceContext.getResourceMetadata(job.params.resourceId, this.config);

    if (!resource) {
      throw new Error(`Resource ${job.params.resourceId} not found`);
    }

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
      job.params.resourceId,
      this.config,
      job.params.instructions,
      job.params.density
    );

    console.log(`[HighlightDetectionWorker] Found ${highlights.length} highlights to create`);

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
        await this.createHighlightAnnotation(job.params.resourceId, job.metadata.userId, highlight);
        created++;
      } catch (error) {
        console.error(`[HighlightDetectionWorker] Failed to create highlight:`, error);
      }
    }

    // Note: JobWorker base class will create the CompleteJob with result
    // We don't set job.result here - that's handled by the base class

    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'creating',
        percentage: 100,
        message: `Complete! Created ${created} highlights`
      }
    };

    await this.updateJobProgress(updatedJob);
    console.log(`[HighlightDetectionWorker] ✅ Created ${created}/${highlights.length} highlights`);
  }

  private async createHighlightAnnotation(
    resourceId: ResourceId,
    creatorUserId: string,
    highlight: HighlightMatch
  ): Promise<void> {
    const backendUrl = this.config.services.backend?.publicURL;
    if (!backendUrl) throw new Error('Backend publicURL not configured');

    const annotationId = generateAnnotationId(backendUrl);
    const resourceUri = resourceIdToURI(resourceId, backendUrl);

    // Create W3C annotation with motivation: highlighting
    // Use both TextPositionSelector and TextQuoteSelector (with prefix/suffix for fuzzy anchoring)
    const annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      'id': annotationId,
      'motivation': 'highlighting' as const,
      'creator': userId(creatorUserId),
      'created': new Date().toISOString(),
      'target': {
        type: 'SpecificResource' as const,
        source: resourceUri,
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

    await this.eventStore.appendEvent({
      type: 'annotation.added',
      resourceId,
      userId: userId(creatorUserId),
      version: 1,
      payload: { annotation }
    });
  }
}
