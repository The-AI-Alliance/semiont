/**
 * Tag Detection Worker
 *
 * Processes tag-detection jobs: runs AI inference to identify passages
 * serving specific structural roles (IRAC, IMRAD, Toulmin, etc.) and
 * creates tag annotations with dual-body structure.
 */

import { JobWorker } from '../job-worker';
import type { AnyJob, TagDetectionJob, RunningJob, TagDetectionParams, TagDetectionProgress, TagDetectionResult, ContentFetcher } from '../types';
import type { JobQueue } from '../job-queue';
import { AnnotationDetection } from './annotation-detection';
import { generateAnnotationId } from '@semiont/event-sourcing';
import { resourceIdToURI, EventBus, userToAgent, type Logger } from '@semiont/core';
import { getTagSchema } from '@semiont/ontology';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { userId, jobId } from '@semiont/core';
import type { TagMatch } from './detection/motivation-parsers';
import type { InferenceClient } from '@semiont/inference';

export class TagAnnotationWorker extends JobWorker {
  private isFirstProgress = true;

  constructor(
    jobQueue: JobQueue,
    private config: EnvironmentConfig,
    private inferenceClient: InferenceClient,
    private eventBus: EventBus,
    private contentFetcher: ContentFetcher,
    logger: Logger
  ) {
    super(jobQueue, undefined, undefined, logger);
  }

  protected getWorkerName(): string {
    return 'TagAnnotationWorker';
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
   * Override base class to emit on EventBus
   */
  protected override async emitCompletionEvent(
    job: RunningJob<TagDetectionParams, TagDetectionProgress>,
    result: TagDetectionResult
  ): Promise<void> {
    this.eventBus.get('job:complete').next({
      resourceId: job.params.resourceId,
      userId: userId(job.metadata.userId),
      jobId: jobId(job.metadata.id),
      jobType: 'tag-annotation',
      result: { result },
    });
  }

  /**
   * Override updateJobProgress to emit events via EventBus
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

    if (this.isFirstProgress) {
      // First progress update - record job started
      this.isFirstProgress = false;
      this.eventBus.get('job:start').next({
        resourceId: tdJob.params.resourceId,
        userId: userId(tdJob.metadata.userId),
        jobId: jobId(tdJob.metadata.id),
        jobType: tdJob.metadata.type,
      });
    } else {
      // Intermediate progress - record job progress
      this.eventBus.get('job:report-progress').next({
        resourceId: tdJob.params.resourceId,
        userId: userId(tdJob.metadata.userId),
        jobId: jobId(tdJob.metadata.id),
        jobType: tdJob.metadata.type,
        percentage: tdJob.progress.percentage,
        progress: { progress: tdJob.progress },
      });
      // Ephemeral progress for real-time UI updates
      const resourceBus = this.eventBus.scope(tdJob.params.resourceId);
      resourceBus.get('mark:progress').next({
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

    // If job permanently failed, record via EventBus
    if (job.status === 'failed' && job.metadata.type === 'tag-annotation') {
      const tdJob = job as TagDetectionJob;

      this.eventBus.get('job:fail').next({
        resourceId: tdJob.params.resourceId,
        userId: userId(tdJob.metadata.userId),
        jobId: jobId(tdJob.metadata.id),
        jobType: tdJob.metadata.type,
        error: 'Tag detection failed. Please try again later.',
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

    // Fetch content via ContentFetcher
    const content = await AnnotationDetection.fetchContent(this.contentFetcher, job.params.resourceId);

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
        content,
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
        await this.createTagAnnotation(job.params.resourceId, job.metadata, job.params.schemaId, tag);
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
    metadata: import('../types').JobMetadata,
    schemaId: string,
    tag: TagMatch
  ): Promise<void> {
    const backendUrl = this.config.services.backend?.publicURL;

    if (!backendUrl) {
      throw new Error('Backend publicURL not configured');
    }

    const resourceUri = resourceIdToURI(resourceId, backendUrl);
    const annotationIdVal = generateAnnotationId(backendUrl);

    const creator = userToAgent({
      id: metadata.userId,
      name: metadata.userName,
      email: metadata.userEmail,
      domain: metadata.userDomain,
    });

    // Create W3C-compliant annotation with dual-body structure:
    // 1. purpose: "tagging" with category value
    // 2. purpose: "classifying" with schema ID
    const annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      type: 'Annotation' as const,
      id: annotationIdVal,
      motivation: 'tagging' as const,
      creator,
      created: new Date().toISOString(),
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

    this.eventBus.get('mark:create').next({
      annotation,
      userId: userId(metadata.userId),
      resourceId,
    });

    this.logger?.debug('Created tag annotation', {
      annotationId: annotationIdVal,
      category: tag.category,
      exactPreview: tag.exact.substring(0, 50)
    });
  }
}
