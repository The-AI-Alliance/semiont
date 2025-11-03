/**
 * Generation Worker
 *
 * Processes generation jobs: runs AI inference to generate new resources
 * and emits resource.created and annotation.body.updated events.
 *
 * This worker is INDEPENDENT of HTTP clients - it just processes jobs and emits events.
 */

import { JobWorker } from './job-worker';
import type { Job, GenerationJob } from '../types';
import { FilesystemRepresentationStore } from '../../storage/representation/representation-store';
import { AnnotationQueryService } from '../../services/annotation-queries';
import { ResourceQueryService } from '../../services/resource-queries';
import { generateResourceFromTopic } from '../../inference/factory';
import { getTargetSelector } from '../../lib/annotation-utils';
import {
  CREATION_METHODS,
  generateUuid,
  type BodyOperation,
  resourceId,
  annotationId,
} from '@semiont/core';
import { getExactText, compareAnnotationIds } from '@semiont/api-client';
import { createEventStore } from '../../services/event-store-service';

import { getEntityTypes } from '@semiont/api-client';
import type { EnvironmentConfig } from '@semiont/core';

export class GenerationWorker extends JobWorker {
  constructor(private config: EnvironmentConfig) {
    super();
  }

  protected getWorkerName(): string {
    return 'GenerationWorker';
  }

  protected canProcessJob(job: Job): boolean {
    return job.type === 'generation';
  }

  protected async executeJob(job: Job): Promise<void> {
    if (job.type !== 'generation') {
      throw new Error(`Invalid job type: ${job.type}`);
    }

    await this.processGenerationJob(job);
  }

  private async processGenerationJob(job: GenerationJob): Promise<void> {
    console.log(`[GenerationWorker] Processing generation for reference ${job.referenceId} (job: ${job.id})`);

    const basePath = this.config.services.filesystem!.path;
    const repStore = new FilesystemRepresentationStore({ basePath });

    // Update progress: fetching
    job.progress = {
      stage: 'fetching',
      percentage: 20,
      message: 'Fetching source resource...'
    };
    console.log(`[GenerationWorker] 📥 ${job.progress.message}`);
    await this.updateJobProgress(job);

    // Fetch annotation from Layer 3
    const projection = await AnnotationQueryService.getResourceAnnotations(job.sourceResourceId, this.config);
    // Compare by ID portion (handle both URI and simple ID formats)
    const annotation = projection.annotations.find((a: any) =>
      compareAnnotationIds(a.id, job.referenceId) && a.motivation === 'linking'
    );

    if (!annotation) {
      throw new Error(`Reference annotation ${job.referenceId} not found in resource ${job.sourceResourceId}`);
    }

    const sourceResource = await ResourceQueryService.getResourceMetadata(job.sourceResourceId, this.config);
    if (!sourceResource) {
      throw new Error(`Source resource ${job.sourceResourceId} not found`);
    }

    // Determine resource name
    const targetSelector = getTargetSelector(annotation.target);
    const resourceName = job.title || (targetSelector ? getExactText(targetSelector) : '') || 'New Resource';
    console.log(`[GenerationWorker] Generating resource: "${resourceName}"`);

    // Update progress: generating
    job.progress = {
      stage: 'generating',
      percentage: 40,
      message: 'Creating content with AI...'
    };
    console.log(`[GenerationWorker] 🤖 ${job.progress.message}`);
    await this.updateJobProgress(job);

    // Generate content using AI
    const prompt = job.prompt || `Create a comprehensive resource about "${resourceName}"`;
    // Extract entity types from annotation body
    const annotationEntityTypes = getEntityTypes({ body: annotation.body });

    const generatedContent = await generateResourceFromTopic(
      resourceName,
      job.entityTypes || annotationEntityTypes,
      prompt,
      job.language
    );

    console.log(`[GenerationWorker] ✅ Generated ${generatedContent.content.length} bytes of content`);

    // Update progress: creating
    job.progress = {
      stage: 'generating',
      percentage: 70,
      message: 'Content ready, creating resource...'
    };
    await this.updateJobProgress(job);

    // Generate resource ID
    const rId = resourceId(generateUuid());

    // Update progress: creating
    job.progress = {
      stage: 'creating',
      percentage: 85,
      message: 'Saving resource...'
    };
    console.log(`[GenerationWorker] 💾 ${job.progress.message}`);
    await this.updateJobProgress(job);

    // Save content to RepresentationStore
    const storedRep = await repStore.store(Buffer.from(generatedContent.content), {
      mediaType: 'text/markdown',
      rel: 'original',
    });
    console.log(`[GenerationWorker] ✅ Saved resource representation to filesystem: ${rId}`);

    // Emit resource.created event
    const eventStore = await createEventStore(basePath);
    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: rId,
      userId: job.userId,
      version: 1,
      payload: {
        name: resourceName,
        format: 'text/markdown',
        contentChecksum: storedRep.checksum,
        creationMethod: CREATION_METHODS.GENERATED,
        entityTypes: job.entityTypes || annotationEntityTypes,
        language: job.language,
        isDraft: true,
        generatedFrom: job.referenceId,
        generationPrompt: undefined,  // Could be added if we track the prompt
      },
    });
    console.log(`[GenerationWorker] Emitted resource.created event for ${rId}`);

    // Update progress: linking
    job.progress = {
      stage: 'linking',
      percentage: 95,
      message: 'Linking reference...'
    };
    console.log(`[GenerationWorker] 🔗 ${job.progress.message}`);
    await this.updateJobProgress(job);

    // Emit annotation.body.updated event to link the annotation to the new resource
    const operations: BodyOperation[] = [{
      op: 'add',
      item: {
        type: 'SpecificResource',
        source: rId,
        purpose: 'linking',
      },
    }];

    await eventStore.appendEvent({
      type: 'annotation.body.updated',
      resourceId: job.sourceResourceId,
      userId: job.userId,
      version: 1,
      payload: {
        annotationId: annotationId(job.referenceId),
        operations,
      },
    });
    console.log(`[GenerationWorker] ✅ Emitted annotation.body.updated event linking ${job.referenceId} → ${rId}`);

    // Set final result
    job.result = {
      resourceId: rId,
      resourceName
    };

    job.progress = {
      stage: 'linking',
      percentage: 100,
      message: 'Complete!'
    };
    await this.updateJobProgress(job);

    console.log(`[GenerationWorker] ✅ Generation complete: created resource ${rId}`);
  }

  /**
   * Update job progress and emit events to Event Store
   * Overrides base class to also emit job progress events
   */
  protected override async updateJobProgress(job: Job): Promise<void> {
    // Call parent to update job queue
    await super.updateJobProgress(job);

    // Emit events for generation jobs
    if (job.type !== 'generation') {
      return;
    }

    const genJob = job as GenerationJob;
    const basePath = this.config.services.filesystem!.path;
    const eventStore = await createEventStore(basePath);

    const baseEvent = {
      resourceId: genJob.sourceResourceId,
      userId: genJob.userId,
      version: 1,
    };

    // Emit appropriate event based on progress stage
    if (genJob.progress?.stage === 'fetching' && genJob.progress?.percentage === 20) {
      // First progress update - emit job.started
      await eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: genJob.id,
          jobType: genJob.type,
          totalSteps: 5, // fetching, generating, creating, linking, complete
        },
      });
    } else if (genJob.progress?.stage === 'linking' && genJob.progress?.percentage === 100) {
      // Final progress update - emit job.completed
      await eventStore.appendEvent({
        type: 'job.completed',
        ...baseEvent,
        payload: {
          jobId: genJob.id,
          jobType: genJob.type,
          resultResourceId: genJob.result?.resourceId,
        },
      });
    } else if (genJob.progress) {
      // Intermediate progress - emit job.progress
      await eventStore.appendEvent({
        type: 'job.progress',
        ...baseEvent,
        payload: {
          jobId: genJob.id,
          jobType: genJob.type,
          currentStep: genJob.progress.stage,
          percentage: genJob.progress.percentage,
          message: genJob.progress.message,
        },
      });
    }
  }
}
