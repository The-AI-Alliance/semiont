/**
 * Tag Detection Worker
 *
 * Processes tag-detection jobs: runs AI inference to identify passages
 * serving specific structural roles (IRAC, IMRAD, Toulmin, etc.) and
 * creates tag annotations with dual-body structure.
 */

import { JobWorker } from '@semiont/jobs';
import type { AnyJob, TagDetectionJob, JobQueue, RunningJob, TagDetectionParams, TagDetectionProgress, TagDetectionResult } from '@semiont/jobs';
import { ResourceContext, AnnotationDetection } from '..';
import { EventStore, generateAnnotationId } from '@semiont/event-sourcing';
import { resourceIdToURI, EventBus, type Logger } from '@semiont/core';
import { getTagSchema } from '@semiont/ontology';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { userId } from '@semiont/core';
import type { TagMatch } from '../detection/motivation-parsers';
import type { InferenceClient } from '@semiont/inference';

export class TagDetectionWorker extends JobWorker {
  private isFirstProgress = true;

  constructor(
    jobQueue: JobQueue,
    private config: EnvironmentConfig,
    private eventStore: EventStore,
    private inferenceClient: InferenceClient,
    private eventBus: EventBus,
    logger: Logger
  ) {
    super(jobQueue, undefined, undefined, logger);
  }

  protected getWorkerName(): string {
    return 'TagDetectionWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'tag-annotation';
  }

  protected async executeJob(job: AnyJob): Promise<TagDetectionResult> {
    if (job.metadata.type !== 'tag-annotation') {
      throw new Error(`Invalid job type: ${job.metadata.type}`);
    }

    // Type guard: job must be running to execute
    if (job.status !== 'running') {
      throw new Error(`Job must be in running state to execute, got: ${job.status}`);
    }

    // Reset progress tracking
    this.isFirstProgress = true;
    return await this.processTagDetectionJob(job as RunningJob<TagDetectionParams, TagDetectionProgress>);
  }

  /**
   * Emit completion event with result data
   * Override base class to emit job.completed event
   */
  protected override async emitCompletionEvent(
    job: RunningJob<TagDetectionParams, TagDetectionProgress>,
    result: TagDetectionResult
  ): Promise<void> {
    await this.eventStore.appendEvent({
      type: 'job.completed',
      resourceId: job.params.resourceId,
      userId: job.metadata.userId,
      version: 1,
      payload: {
        jobId: job.metadata.id,
        jobType: 'tag-annotation',
        result,
      },
    });

    // Emit to EventBus for real-time subscribers
    // Domain event (job.completed) is automatically published to EventBus by EventStore
    // Backend SSE endpoint will subscribe to job.completed and transform to annotate:detect-finished
  }

  /**
   * Override updateJobProgress to emit events to Event Store
   */
  protected override async updateJobProgress(job: AnyJob): Promise<void> {
    // Call parent to update filesystem
    await super.updateJobProgress(job);

    if (job.metadata.type !== 'tag-annotation') return;

    // Type guard: only running jobs have progress
    if (job.status !== 'running') {
      return;
    }

    const tdJob = job as RunningJob<TagDetectionParams, TagDetectionProgress>;

    const baseEvent = {
      resourceId: tdJob.params.resourceId,
      userId: tdJob.metadata.userId,
      version: 1,
    };

    const resourceBus = this.eventBus.scope(tdJob.params.resourceId);

    if (this.isFirstProgress) {
      // First progress update - emit job.started
      this.isFirstProgress = false;
      await this.eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: tdJob.metadata.id,
          jobType: tdJob.metadata.type,
        },
      });
    } else {
      // Intermediate progress - emit job.progress
      // Note: job.completed is now handled by emitCompletionEvent()
      await this.eventStore.appendEvent({
        type: 'job.progress',
        ...baseEvent,
        payload: {
          jobId: tdJob.metadata.id,
          jobType: tdJob.metadata.type,
          progress: tdJob.progress,
        },
      });
      resourceBus.get('annotate:progress').next({
        status: tdJob.progress.stage,
        message: tdJob.progress.message,
        percentage: tdJob.progress.percentage,
        currentCategory: tdJob.progress.currentCategory,
        processedCategories: tdJob.progress.processedCategories,
        totalCategories: tdJob.progress.totalCategories
      });
    }
  }

  protected override async handleJobFailure(job: AnyJob, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, emit job.failed event
    if (job.status === 'failed' && job.metadata.type === 'tag-annotation') {
      const tdJob = job as TagDetectionJob;

      await this.eventStore.appendEvent({
        type: 'job.failed',
        resourceId: tdJob.params.resourceId,
        userId: tdJob.metadata.userId,
        version: 1,
        payload: {
          jobId: tdJob.metadata.id,
          jobType: tdJob.metadata.type,
          error: 'Tag detection failed. Please try again later.',
        },
      });
    }
  }

  private async processTagDetectionJob(job: RunningJob<TagDetectionParams, TagDetectionProgress>): Promise<TagDetectionResult> {
    this.logger?.info('Processing tag detection job', {
      resourceId: job.params.resourceId,
      jobId: job.metadata.id
    });

    // Validate schema
    const schema = getTagSchema(job.params.schemaId);
    if (!schema) {
      throw new Error(`Invalid tag schema: ${job.params.schemaId}`);
    }

    // Validate categories
    for (const category of job.params.categories) {
      if (!schema.tags.some(t => t.name === category)) {
        throw new Error(`Invalid category "${category}" for schema ${job.params.schemaId}`);
      }
    }

    // Fetch resource content
    const resource = await ResourceContext.getResourceMetadata(job.params.resourceId, this.config);
    if (!resource) {
      throw new Error(`Resource ${job.params.resourceId} not found`);
    }

    // Emit job.started
    let updatedJob: RunningJob<TagDetectionParams, TagDetectionProgress> = {
      ...job,
      progress: {
        stage: 'analyzing',
        percentage: 10,
        processedCategories: 0,
        totalCategories: job.params.categories.length,
        message: 'Loading resource...'
      }
    };
    await this.updateJobProgress(updatedJob);

    // Process each category separately
    const allTags: TagMatch[] = [];
    const byCategory: Record<string, number> = {};

    for (let i = 0; i < job.params.categories.length; i++) {
      const category = job.params.categories[i]!; // Safe: i < length check guarantees element exists

      updatedJob = {
        ...updatedJob,
        progress: {
          stage: 'analyzing',
          percentage: 10 + Math.floor((i / job.params.categories.length) * 50),
          currentCategory: category,
          processedCategories: i + 1,
          totalCategories: job.params.categories.length,
          message: `Analyzing ${category}...`
        }
      };
      await this.updateJobProgress(updatedJob);

      // Detect tags for this category
      const tags = await AnnotationDetection.detectTags(
        job.params.resourceId,
        this.config,
        this.inferenceClient,
        job.params.schemaId,
        category
      );
      this.logger?.info('Found tags for category', { category, count: tags.length });

      allTags.push(...tags);
      byCategory[category] = tags.length;
    }

    // Create annotations
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'creating',
        percentage: 60,
        processedCategories: job.params.categories.length,
        totalCategories: job.params.categories.length,
        message: `Creating ${allTags.length} tag annotations...`
      }
    };
    await this.updateJobProgress(updatedJob);

    let created = 0;
    for (const tag of allTags) {
      try {
        await this.createTagAnnotation(job.params.resourceId, job.metadata.userId, job.params.schemaId, tag);
        created++;
      } catch (error) {
        this.logger?.error('Failed to create tag', { error });
      }
    }

    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'creating',
        percentage: 100,
        processedCategories: job.params.categories.length,
        totalCategories: job.params.categories.length,
        message: `Complete! Created ${created} tags`
      }
    };

    await this.updateJobProgress(updatedJob);
    this.logger?.info('Tag detection complete', {
      created,
      total: allTags.length,
      categoryCount: job.params.categories.length
    });

    // Return result - base class will use this for CompleteJob and emitCompletionEvent
    return {
      tagsFound: allTags.length,
      tagsCreated: created,
      byCategory
    };
  }

  private async createTagAnnotation(
    resourceId: ResourceId,
    userId_: string,
    schemaId: string,
    tag: TagMatch
  ): Promise<void> {
    const backendUrl = this.config.services.backend?.publicURL;

    if (!backendUrl) {
      throw new Error('Backend publicURL not configured');
    }

    const resourceUri = resourceIdToURI(resourceId, backendUrl);
    const annotationId = generateAnnotationId(backendUrl);

    // Create W3C-compliant annotation with dual-body structure:
    // 1. purpose: "tagging" with category value
    // 2. purpose: "classifying" with schema ID
    const annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      type: 'Annotation' as const,
      id: annotationId,
      motivation: 'tagging' as const,
      target: {
        type: 'SpecificResource' as const,
        source: resourceUri,
        selector: [
          {
            type: 'TextPositionSelector' as const,
            start: tag.start,
            end: tag.end
          },
          {
            type: 'TextQuoteSelector' as const,
            exact: tag.exact,
            prefix: tag.prefix || '',
            suffix: tag.suffix || ''
          }
        ]
      },
      body: [
        {
          type: 'TextualBody' as const,
          value: tag.category,
          purpose: 'tagging' as const,
          format: 'text/plain',
          language: 'en'
        },
        {
          type: 'TextualBody' as const,
          value: schemaId,
          purpose: 'classifying' as const,
          format: 'text/plain'
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

    this.logger?.debug('Created tag annotation', {
      annotationId,
      category: tag.category,
      exactPreview: tag.exact.substring(0, 50)
    });
  }
}
