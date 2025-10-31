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
import { generateResourceFromTopic } from '../../inference/factory';
import { getTargetSelector } from '../../lib/annotation-utils';
import {
  CREATION_METHODS,
  generateUuid,
  type BodyOperation,
} from '@semiont/core';
import { getExactText, extractAnnotationId } from '@semiont/api-client';
import { createEventStore } from '../../services/event-store-service';

import { getEntityTypes } from '@semiont/api-client';
import { getFilesystemConfig, getBackendConfig } from '../../config/environment-loader';
import type { components } from '@semiont/api-client';

type AnnotationLLMContextResponse = components['schemas']['AnnotationLLMContextResponse'];

export class GenerationWorker extends JobWorker {
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

    const basePath = getFilesystemConfig().path;
    const repStore = new FilesystemRepresentationStore({ basePath });
    const eventStore = await createEventStore(basePath);

    // Emit job.started event
    await eventStore.appendEvent({
      type: 'job.started',
      resourceId: job.sourceResourceId,
      userId: job.userId,
      version: 1,
      payload: {
        jobId: job.id,
        jobType: 'generation',
        totalSteps: 5,  // fetching, generating, creating, linking, complete
      },
    });

    // Emit job.progress event (fetching)
    await eventStore.appendEvent({
      type: 'job.progress',
      resourceId: job.sourceResourceId,
      userId: job.userId,
      version: 1,
      payload: {
        jobId: job.id,
        jobType: 'generation',
        percentage: 20,
        currentStep: 'fetching',
        processedSteps: 1,
        totalSteps: 5,
        message: 'Fetching annotation context...',
      },
    });

    // Fetch rich LLM context using the annotation-llm-context endpoint
    const backendURL = getBackendConfig().publicURL;
    const annotationId = extractAnnotationId(job.referenceId);
    const contextURL = `${backendURL}/api/resources/${encodeURIComponent(job.sourceResourceId)}/annotations/${encodeURIComponent(annotationId)}/llm-context?includeSourceContext=true&includeTargetContext=false&contextWindow=2000`;

    console.log(`[GenerationWorker] Fetching LLM context from: ${contextURL}`);

    const contextResponse = await fetch(contextURL);
    if (!contextResponse.ok) {
      throw new Error(`Failed to fetch annotation context: ${contextResponse.status} ${contextResponse.statusText}`);
    }

    const llmContext = await contextResponse.json() as AnnotationLLMContextResponse;
    console.log(`[GenerationWorker] Retrieved LLM context with source context: ${!!llmContext.sourceContext}`);

    // Determine resource name
    const targetSelector = getTargetSelector(llmContext.annotation.target);
    const resourceName = job.title || (targetSelector ? getExactText(targetSelector) : '') || 'New Resource';
    console.log(`[GenerationWorker] Generating resource: "${resourceName}"`);

    // Emit job.progress event (generating)
    await eventStore.appendEvent({
      type: 'job.progress',
      resourceId: job.sourceResourceId,
      userId: job.userId,
      version: 1,
      payload: {
        jobId: job.id,
        jobType: 'generation',
        percentage: 40,
        currentStep: 'generating',
        processedSteps: 2,
        totalSteps: 5,
        message: 'Creating content with AI...',
      },
    });

    // Build enriched prompt with source context
    let enrichedPrompt = job.prompt || `Create a comprehensive resource about "${resourceName}"`;

    if (llmContext.sourceContext) {
      const { before, selected, after } = llmContext.sourceContext;
      enrichedPrompt += `\n\nSource Context:\nThe phrase "${selected}" appears in this context:\n...${before}[${selected}]${after}...`;
      console.log(`[GenerationWorker] Including source context (${before.length + selected.length + after.length} chars)`);
    }

    // Extract entity types from annotation body
    const annotationEntityTypes = getEntityTypes({ body: llmContext.annotation.body });

    const generatedContent = await generateResourceFromTopic(
      resourceName,
      job.entityTypes || annotationEntityTypes,
      enrichedPrompt,
      job.language
    );

    console.log(`[GenerationWorker] ✅ Generated ${generatedContent.content.length} bytes of content`);

    // Generate resource ID
    const resourceId = generateUuid();

    // Emit job.progress event (creating)
    await eventStore.appendEvent({
      type: 'job.progress',
      resourceId: job.sourceResourceId,
      userId: job.userId,
      version: 1,
      payload: {
        jobId: job.id,
        jobType: 'generation',
        percentage: 85,
        currentStep: 'creating',
        processedSteps: 4,
        totalSteps: 5,
        message: 'Saving resource...',
      },
    });

    // Save content to RepresentationStore
    const storedRep = await repStore.store(Buffer.from(generatedContent.content), {
      mediaType: 'text/markdown',
      rel: 'original',
    });
    console.log(`[GenerationWorker] ✅ Saved resource representation to filesystem: ${resourceId}`);

    // Emit resource.created event
    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId,
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
    console.log(`[GenerationWorker] Emitted resource.created event for ${resourceId}`);

    // Emit annotation.body.updated event to link the annotation to the new resource
    const operations: BodyOperation[] = [{
      op: 'add',
      item: {
        type: 'SpecificResource',
        source: resourceId,
        purpose: 'linking',
      },
    }];

    await eventStore.appendEvent({
      type: 'annotation.body.updated',
      resourceId: job.sourceResourceId,
      userId: job.userId,
      version: 1,
      payload: {
        annotationId: job.referenceId,
        operations,
      },
    });
    console.log(`[GenerationWorker] ✅ Emitted annotation.body.updated event linking ${job.referenceId} → ${resourceId}`);

    // Set final result
    job.result = {
      resourceId,
      resourceName
    };

    // Emit job.completed event
    await eventStore.appendEvent({
      type: 'job.completed',
      resourceId: job.sourceResourceId,
      userId: job.userId,
      version: 1,
      payload: {
        jobId: job.id,
        jobType: 'generation',
        totalSteps: 5,
        resultResourceId: resourceId,
        message: `Generation complete: created resource "${resourceName}"`,
      },
    });

    console.log(`[GenerationWorker] ✅ Generation complete: created resource ${resourceId}`);
  }
}
