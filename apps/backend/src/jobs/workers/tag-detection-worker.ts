/**
 * Tag Detection Worker
 *
 * Processes tag-detection jobs: runs AI inference to identify passages
 * serving specific structural roles (IRAC, IMRAD, Toulmin, etc.) and
 * creates tag annotations with dual-body structure.
 */

import { JobWorker } from '@semiont/jobs';
import type { Job, TagDetectionJob } from '@semiont/jobs';
import { ResourceContext, AnnotationDetection } from '@semiont/make-meaning';
import { createEventStore } from '../../services/event-store-service';
import { generateAnnotationId } from '../../utils/id-generator';
import { resourceIdToURI } from '@semiont/core';
import { getTagSchema } from '@semiont/ontology';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { userId } from '@semiont/core';
import type { TagMatch } from '@semiont/inference';

export class TagDetectionWorker extends JobWorker {
  private isFirstProgress = true;

  constructor(private config: EnvironmentConfig) {
    super();
  }

  protected getWorkerName(): string {
    return 'TagDetectionWorker';
  }

  protected canProcessJob(job: Job): boolean {
    return job.type === 'tag-detection';
  }

  protected async executeJob(job: Job): Promise<void> {
    if (job.type !== 'tag-detection') {
      throw new Error(`Invalid job type: ${job.type}`);
    }

    // Reset progress tracking
    this.isFirstProgress = true;
    await this.processTagDetectionJob(job);
  }

  /**
   * Override updateJobProgress to emit events to Event Store
   */
  protected override async updateJobProgress(job: Job): Promise<void> {
    // Call parent to update filesystem
    await super.updateJobProgress(job);

    if (job.type !== 'tag-detection') return;

    const tdJob = job as TagDetectionJob;
    if (!tdJob.progress) return;

    const eventStore = await createEventStore(this.config);
    const baseEvent = {
      resourceId: tdJob.resourceId,
      userId: tdJob.userId,
      version: 1,
    };

    // Determine if this is completion (100% and has result)
    const isComplete = tdJob.progress.percentage === 100 && tdJob.result;

    if (this.isFirstProgress) {
      // First progress update - emit job.started
      this.isFirstProgress = false;
      await eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: tdJob.id,
          jobType: tdJob.type,
        },
      });
    } else if (isComplete) {
      // Final update - emit job.completed
      await eventStore.appendEvent({
        type: 'job.completed',
        ...baseEvent,
        payload: {
          jobId: tdJob.id,
          jobType: tdJob.type,
          result: tdJob.result,
        },
      });
    } else {
      // Intermediate progress - emit job.progress
      await eventStore.appendEvent({
        type: 'job.progress',
        ...baseEvent,
        payload: {
          jobId: tdJob.id,
          jobType: tdJob.type,
          progress: tdJob.progress,
        },
      });
    }
  }

  protected override async handleJobFailure(job: Job, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, emit job.failed event
    if (job.status === 'failed' && job.type === 'tag-detection') {
      const tdJob = job as TagDetectionJob;
      const eventStore = await createEventStore(this.config);

      await eventStore.appendEvent({
        type: 'job.failed',
        resourceId: tdJob.resourceId,
        userId: tdJob.userId,
        version: 1,
        payload: {
          jobId: tdJob.id,
          jobType: tdJob.type,
          error: 'Tag detection failed. Please try again later.',
        },
      });
    }
  }

  private async processTagDetectionJob(job: TagDetectionJob): Promise<void> {
    console.log(`[TagDetectionWorker] Processing tag detection for resource ${job.resourceId} (job: ${job.id})`);

    // Validate schema
    const schema = getTagSchema(job.schemaId);
    if (!schema) {
      throw new Error(`Invalid tag schema: ${job.schemaId}`);
    }

    // Validate categories
    for (const category of job.categories) {
      if (!schema.tags.some(t => t.name === category)) {
        throw new Error(`Invalid category "${category}" for schema ${job.schemaId}`);
      }
    }

    // Fetch resource content
    const resource = await ResourceContext.getResourceMetadata(job.resourceId, this.config);
    if (!resource) {
      throw new Error(`Resource ${job.resourceId} not found`);
    }

    // Emit job.started
    job.progress = {
      stage: 'analyzing',
      percentage: 10,
      processedCategories: 0,
      totalCategories: job.categories.length,
      message: 'Loading resource...'
    };
    await this.updateJobProgress(job);

    // Process each category separately
    const allTags: TagMatch[] = [];
    const byCategory: Record<string, number> = {};

    for (let i = 0; i < job.categories.length; i++) {
      const category = job.categories[i]!; // Safe: i < length check guarantees element exists

      job.progress = {
        stage: 'analyzing',
        percentage: 10 + Math.floor((i / job.categories.length) * 50),
        currentCategory: category,
        processedCategories: i + 1,
        totalCategories: job.categories.length,
        message: `Analyzing ${category}...`
      };
      await this.updateJobProgress(job);

      // Detect tags for this category
      const tags = await AnnotationDetection.detectTags(
        job.resourceId,
        this.config,
        job.schemaId,
        category
      );
      console.log(`[TagDetectionWorker] Found ${tags.length} tags for category "${category}"`);

      allTags.push(...tags);
      byCategory[category] = tags.length;
    }

    // Create annotations
    job.progress = {
      stage: 'creating',
      percentage: 60,
      processedCategories: job.categories.length,
      totalCategories: job.categories.length,
      message: `Creating ${allTags.length} tag annotations...`
    };
    await this.updateJobProgress(job);

    let created = 0;
    for (const tag of allTags) {
      try {
        await this.createTagAnnotation(job.resourceId, job.userId, job.schemaId, tag);
        created++;
      } catch (error) {
        console.error(`[TagDetectionWorker] Failed to create tag:`, error);
      }
    }

    // Complete job
    job.result = {
      tagsFound: allTags.length,
      tagsCreated: created,
      byCategory
    };

    job.progress = {
      stage: 'creating',
      percentage: 100,
      processedCategories: job.categories.length,
      totalCategories: job.categories.length,
      message: `Complete! Created ${created} tags`
    };

    await this.updateJobProgress(job);
    console.log(`[TagDetectionWorker] ✅ Created ${created}/${allTags.length} tags across ${job.categories.length} categories`);
  }

  private async createTagAnnotation(
    resourceId: ResourceId,
    userId_: string,
    schemaId: string,
    tag: TagMatch
  ): Promise<void> {
    const eventStore = await createEventStore(this.config);
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
    await eventStore.appendEvent({
      type: 'annotation.added',
      resourceId,
      userId: userId(userId_),
      version: 1,
      payload: {
        annotation
      }
    });

    console.log(`[TagDetectionWorker] Created tag annotation ${annotationId} for "${tag.category}": "${tag.exact.substring(0, 50)}..."`);
  }
}
