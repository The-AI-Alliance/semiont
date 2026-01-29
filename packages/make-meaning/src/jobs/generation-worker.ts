/**
 * Generation Worker
 *
 * Processes generation jobs: runs AI inference to generate new resources
 * and emits resource.created and annotation.body.updated events.
 *
 * This worker is INDEPENDENT of HTTP clients - it just processes jobs and emits events.
 */

import { JobWorker } from '@semiont/jobs';
import type { AnyJob, JobQueue, RunningJob, GenerationParams, GenerationProgress } from '@semiont/jobs';
import { FilesystemRepresentationStore } from '@semiont/content';
import { ResourceContext } from '..';
import { generateResourceFromTopic } from '../generation/resource-generation';
import {
  getTargetSelector,
  getExactText,
  resourceUri,
  annotationUri,
} from '@semiont/api-client';
import { getEntityTypes } from '@semiont/ontology';
import {
  CREATION_METHODS,
  generateUuid,
  type BodyOperation,
  resourceId,
  annotationId,
} from '@semiont/core';
import { EventStore } from '@semiont/event-sourcing';
import type { EnvironmentConfig } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';

export class GenerationWorker extends JobWorker {
  constructor(
    jobQueue: JobQueue,
    private config: EnvironmentConfig,
    private eventStore: EventStore,
    private inferenceClient: InferenceClient
  ) {
    super(jobQueue);
  }

  protected getWorkerName(): string {
    return 'GenerationWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'generation';
  }

  protected async executeJob(job: AnyJob): Promise<void> {
    if (job.metadata.type !== 'generation') {
      throw new Error(`Invalid job type: ${job.metadata.type}`);
    }

    // Type guard: job must be running to execute
    if (job.status !== 'running') {
      throw new Error(`Job must be in running state to execute, got: ${job.status}`);
    }

    await this.processGenerationJob(job as RunningJob<GenerationParams, GenerationProgress>);
  }

  private async processGenerationJob(job: RunningJob<GenerationParams, GenerationProgress>): Promise<void> {
    console.log(`[GenerationWorker] Processing generation for reference ${job.params.referenceId} (job: ${job.metadata.id})`);

    const basePath = this.config.services.filesystem!.path;
    const projectRoot = this.config._metadata?.projectRoot;
    const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

    // Update progress: fetching
    let updatedJob: RunningJob<GenerationParams, GenerationProgress> = {
      ...job,
      progress: {
        stage: 'fetching',
        percentage: 20,
        message: 'Fetching source resource...'
      }
    };
    console.log(`[GenerationWorker] 📥 ${updatedJob.progress.message}`);
    await this.updateJobProgress(updatedJob);

    // Fetch annotation from view storage
    // TODO: Once AnnotationContext is consolidated, use it here
    const { FilesystemViewStorage } = await import('@semiont/event-sourcing');
    const viewStorage = new FilesystemViewStorage(basePath, projectRoot);
    const view = await viewStorage.get(job.params.sourceResourceId);
    if (!view) {
      throw new Error(`Resource ${job.params.sourceResourceId} not found`);
    }
    const projection = view.annotations;

    // Construct full annotation URI for comparison
    const expectedAnnotationUri = `${this.config.services.backend!.publicURL}/annotations/${job.params.referenceId}`;
    const annotation = projection.annotations.find((a: any) =>
      a.id === expectedAnnotationUri && a.motivation === 'linking'
    );

    if (!annotation) {
      throw new Error(`Annotation ${job.params.referenceId} not found in resource ${job.params.sourceResourceId}`);
    }

    const sourceResource = await ResourceContext.getResourceMetadata(job.params.sourceResourceId, this.config);
    if (!sourceResource) {
      throw new Error(`Source resource ${job.params.sourceResourceId} not found`);
    }

    // Determine resource name
    const targetSelector = getTargetSelector(annotation.target);
    const resourceName = job.params.title || (targetSelector ? getExactText(targetSelector) : '') || 'New Resource';
    console.log(`[GenerationWorker] Generating resource: "${resourceName}"`);

    // Verify context is provided (required for generation)
    if (!job.params.context) {
      throw new Error('Generation context is required but was not provided in job');
    }
    console.log(`[GenerationWorker] Using pre-fetched context: ${job.params.context.sourceContext?.before?.length || 0} chars before, ${job.params.context.sourceContext?.selected?.length || 0} chars selected, ${job.params.context.sourceContext?.after?.length || 0} chars after`);

    // Update progress: generating (skip fetching context since it's already in job)
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'generating',
        percentage: 40,
        message: 'Creating content with AI...'
      }
    };
    console.log(`[GenerationWorker] 🤖 ${updatedJob.progress.message}`);
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
      job.params.context,      // NEW - context from job (passed from modal)
      job.params.temperature,  // NEW - from job
      job.params.maxTokens     // NEW - from job
    );

    console.log(`[GenerationWorker] ✅ Generated ${generatedContent.content.length} bytes of content`);

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

    // Generate resource ID
    const rId = resourceId(generateUuid());

    // Update progress: creating
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'creating',
        percentage: 85,
        message: 'Saving resource...'
      }
    };
    console.log(`[GenerationWorker] 💾 ${updatedJob.progress.message}`);
    await this.updateJobProgress(updatedJob);

    // Save content to RepresentationStore
    const storedRep = await repStore.store(Buffer.from(generatedContent.content), {
      mediaType: 'text/markdown',
      rel: 'original',
    });
    console.log(`[GenerationWorker] ✅ Saved resource representation to filesystem: ${rId}`);

    // Emit resource.created event
    await this.eventStore.appendEvent({
      type: 'resource.created',
      resourceId: rId,
      userId: job.metadata.userId,
      version: 1,
      payload: {
        name: resourceName,
        format: 'text/markdown',
        contentChecksum: storedRep.checksum,
        creationMethod: CREATION_METHODS.GENERATED,
        entityTypes: job.params.entityTypes || annotationEntityTypes,
        language: job.params.language,
        isDraft: true,
        generatedFrom: job.params.referenceId,
        generationPrompt: undefined,  // Could be added if we track the prompt
      },
    });
    console.log(`[GenerationWorker] Emitted resource.created event for ${rId}`);

    // Update progress: linking
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'linking',
        percentage: 95,
        message: 'Linking reference...',
        resultResourceId: rId  // Store for job.completed event
      }
    };
    console.log(`[GenerationWorker] 🔗 ${updatedJob.progress.message}`);
    await this.updateJobProgress(updatedJob);

    // Emit annotation.body.updated event to link the annotation to the new resource
    // Build full resource URI for the annotation body
    const newResourceUri = resourceUri(`${this.config.services.backend!.publicURL}/resources/${rId}`);

    const operations: BodyOperation[] = [{
      op: 'add',
      item: {
        type: 'SpecificResource',
        source: newResourceUri,
        purpose: 'linking',
      },
    }];

    // Extract annotation ID from full URI (format: http://host/annotations/{id})
    const annotationIdSegment = job.params.referenceId.split('/').pop()!;

    await this.eventStore.appendEvent({
      type: 'annotation.body.updated',
      resourceId: job.params.sourceResourceId,
      userId: job.metadata.userId,
      version: 1,
      payload: {
        annotationId: annotationId(annotationIdSegment),
        operations,
      },
    });
    console.log(`[GenerationWorker] ✅ Emitted annotation.body.updated event linking ${job.params.referenceId} → ${rId}`);

    // Note: JobWorker base class will create the CompleteJob with result
    // We don't set job.result here - that's handled by the base class

    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'linking',
        percentage: 100,
        message: 'Complete!',
        resultResourceId: rId  // Store for job.completed event
      }
    };
    await this.updateJobProgress(updatedJob);

    console.log(`[GenerationWorker] ✅ Generation complete: created resource ${rId}`);
  }

  /**
   * Update job progress and emit events to Event Store
   * Overrides base class to also emit job progress events
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

    const genJob = job as RunningJob<GenerationParams, GenerationProgress>;

    const baseEvent = {
      resourceId: genJob.params.sourceResourceId,
      userId: genJob.metadata.userId,
      version: 1,
    };

    // Emit appropriate event based on progress stage
    if (genJob.progress.stage === 'fetching' && genJob.progress.percentage === 20) {
      // First progress update - emit job.started
      await this.eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: genJob.metadata.id,
          jobType: genJob.metadata.type,
          totalSteps: 5, // fetching, generating, creating, linking, complete
        },
      });
    } else if (genJob.progress.stage === 'linking' && genJob.progress.percentage === 100) {
      // Final progress update - emit job.completed
      await this.eventStore.appendEvent({
        type: 'job.completed',
        ...baseEvent,
        payload: {
          jobId: genJob.metadata.id,
          jobType: genJob.metadata.type,
          resultResourceId: genJob.progress.resultResourceId,
          annotationUri: annotationUri(`${this.config.services.backend!.publicURL}/annotations/${genJob.params.referenceId}`),
        },
      });
    } else {
      // Intermediate progress - emit job.progress
      await this.eventStore.appendEvent({
        type: 'job.progress',
        ...baseEvent,
        payload: {
          jobId: genJob.metadata.id,
          jobType: genJob.metadata.type,
          currentStep: genJob.progress.stage,
          percentage: genJob.progress.percentage,
          message: genJob.progress.message,
        },
      });
    }
  }
}
