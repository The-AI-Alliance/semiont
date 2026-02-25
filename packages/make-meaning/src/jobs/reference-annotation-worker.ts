/**
 * Reference Detection Worker
 *
 * Processes detection jobs: runs AI inference to find entities in resources
 * and emits reference.created events for each detected entity.
 *
 * This worker is INDEPENDENT of HTTP clients - it just processes jobs and emits events.
 */

import { JobWorker } from '@semiont/jobs';
import type { AnyJob, DetectionJob, JobQueue, RunningJob, DetectionParams, DetectionProgress, DetectionResult } from '@semiont/jobs';
import { ResourceContext } from '..';
import { EventStore, generateAnnotationId } from '@semiont/event-sourcing';
import { resourceIdToURI, EventBus } from '@semiont/core';
import type { EnvironmentConfig, Logger, components } from '@semiont/core';
import { getPrimaryRepresentation, decodeRepresentation, validateAndCorrectOffsets } from '@semiont/api-client';
import { extractEntities } from '../detection/entity-extractor';
import { FilesystemRepresentationStore } from '@semiont/content';
import type { InferenceClient } from '@semiont/inference';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export interface DetectedAnnotation {
  annotation: {
    selector: {
      start: number;
      end: number;
      exact: string;
      prefix?: string;
      suffix?: string;
    };
    entityTypes: string[];
  };
}

export class ReferenceDetectionWorker extends JobWorker {
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
    return 'ReferenceDetectionWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'reference-annotation';
  }

  protected async executeJob(job: AnyJob): Promise<DetectionResult> {
    if (job.metadata.type !== 'reference-annotation') {
      throw new Error(`Invalid job type: ${job.metadata.type}`);
    }

    // Type guard: job must be running to execute
    if (job.status !== 'running') {
      throw new Error(`Job must be in running state to execute, got: ${job.status}`);
    }

    return await this.processDetectionJob(job as RunningJob<DetectionParams, DetectionProgress>);
  }

  /**
   * Detect entity references in resource using AI
   * Self-contained implementation for reference detection
   *
   * Public for testing charset handling - see entity-detection-charset.test.ts
   */
  public async detectReferences(
    resource: ResourceDescriptor,
    entityTypes: string[],
    includeDescriptiveReferences: boolean = false
  ): Promise<DetectedAnnotation[]> {
    this.logger?.debug('Detecting entities', {
      resourceId: resource.id,
      entityTypes,
      includeDescriptiveReferences
    });

    const detectedAnnotations: DetectedAnnotation[] = [];

    // Get primary representation
    const primaryRep = getPrimaryRepresentation(resource);
    if (!primaryRep) return detectedAnnotations;

    // Only process text content (check base media type, ignoring charset parameters)
    const mediaType = primaryRep.mediaType;
    const baseMediaType = mediaType?.split(';')[0]?.trim() || '';
    if (baseMediaType === 'text/plain' || baseMediaType === 'text/markdown') {
      // Load content from representation store using content-addressed lookup
      if (!primaryRep.checksum || !primaryRep.mediaType) return detectedAnnotations;

      const basePath = this.config.services.filesystem!.path;
      const projectRoot = this.config._metadata?.projectRoot;
      const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);
      const contentBuffer = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
      const content = decodeRepresentation(contentBuffer, primaryRep.mediaType);

      // Use AI to extract entities (with optional anaphoric/cataphoric references)
      const extractedEntities = await extractEntities(content, entityTypes, this.inferenceClient, includeDescriptiveReferences);

      // Validate and correct AI's offsets, then extract proper context
      // AI sometimes returns offsets that don't match the actual text position
      for (const entity of extractedEntities) {
        try {
          const validated = validateAndCorrectOffsets(
            content,
            entity.startOffset,
            entity.endOffset,
            entity.exact
          );

          const annotation: DetectedAnnotation = {
            annotation: {
              selector: {
                start: validated.start,
                end: validated.end,
                exact: validated.exact,
                prefix: validated.prefix,
                suffix: validated.suffix,
              },
              entityTypes: [entity.entityType],
            },
          };
          detectedAnnotations.push(annotation);
        } catch (error) {
          this.logger?.warn('Skipping invalid entity', { exact: entity.exact, error });
          // Skip this entity - AI hallucinated text that doesn't exist
        }
      }
    }

    return detectedAnnotations;
  }

  private async processDetectionJob(job: RunningJob<DetectionParams, DetectionProgress>): Promise<DetectionResult> {
    this.logger?.info('Processing detection job', { resourceId: job.params.resourceId, jobId: job.metadata.id });
    this.logger?.debug('Entity types to detect', { entityTypes: job.params.entityTypes });

    // Fetch resource content
    const resource = await ResourceContext.getResourceMetadata(job.params.resourceId, this.config);

    if (!resource) {
      throw new Error(`Resource ${job.params.resourceId} not found`);
    }

    let totalFound = 0;
    let totalEmitted = 0;
    let totalErrors = 0;

    // Create updated job with initial progress
    let updatedJob: RunningJob<DetectionParams, DetectionProgress> = {
      ...job,
      progress: {
        totalEntityTypes: job.params.entityTypes.length,
        processedEntityTypes: 0,
        entitiesFound: 0,
        entitiesEmitted: 0
      }
    };
    await this.updateJobProgress(updatedJob);

    // Process each entity type
    for (let i = 0; i < job.params.entityTypes.length; i++) {
      const entityType = job.params.entityTypes[i];

      if (!entityType) continue;

      this.logger?.info('Detecting entity type', {
        entityType,
        progress: `${i + 1}/${job.params.entityTypes.length}`
      });

      // Emit progress BEFORE inference call for immediate user feedback
      updatedJob = {
        ...updatedJob,
        progress: {
          totalEntityTypes: job.params.entityTypes.length,
          processedEntityTypes: i,
          currentEntityType: entityType,
          entitiesFound: totalFound,
          entitiesEmitted: totalEmitted
        }
      };
      await this.updateJobProgress(updatedJob);

      // Detect entities using AI (loads content from filesystem internally)
      // This is where the latency is - user now has feedback that work started
      const detectedAnnotations = await this.detectReferences(resource, [entityType], job.params.includeDescriptiveReferences);

      totalFound += detectedAnnotations.length;
      this.logger?.info('Found entities', { entityType, count: detectedAnnotations.length });

      // Emit events for each detected entity
      // This happens INDEPENDENT of any HTTP client!
      for (let idx = 0; idx < detectedAnnotations.length; idx++) {
        const detected = detectedAnnotations[idx];

        if (!detected) {
          this.logger?.warn('Skipping undefined entity', { index: idx });
          continue;
        }

        let referenceId: string;
        try {
          const backendUrl = this.config.services.backend?.publicURL;
          if (!backendUrl) {
            throw new Error('Backend publicURL not configured');
          }
          referenceId = generateAnnotationId(backendUrl);
        } catch (error) {
          this.logger?.error('Failed to generate annotation ID', { error });
          throw new Error('Configuration error: Backend publicURL not set');
        }

        try {
          await this.eventStore.appendEvent({
            type: 'annotation.added',
            resourceId: job.params.resourceId,
            userId: job.metadata.userId,
            version: 1,
            payload: {
              annotation: {
                '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
                'type': 'Annotation' as const,
                id: referenceId,
                motivation: 'linking' as const,
                target: {
                  source: resourceIdToURI(job.params.resourceId, this.config.services.backend!.publicURL), // Convert to full URI
                  selector: [
                    {
                      type: 'TextPositionSelector',
                      start: detected.annotation.selector.start,
                      end: detected.annotation.selector.end,
                    },
                    {
                      type: 'TextQuoteSelector',
                      exact: detected.annotation.selector.exact,
                      ...(detected.annotation.selector.prefix && { prefix: detected.annotation.selector.prefix }),
                      ...(detected.annotation.selector.suffix && { suffix: detected.annotation.selector.suffix }),
                    },
                  ],
                },
                body: (detected.annotation.entityTypes || []).map(et => ({
                  type: 'TextualBody' as const,
                  value: et,
                  purpose: 'tagging' as const,
                })),
                modified: new Date().toISOString(),
              },
            },
          });

          totalEmitted++;

          if ((idx + 1) % 10 === 0 || idx === detectedAnnotations.length - 1) {
            this.logger?.debug('Emitted events for entity type', {
              entityType,
              emitted: idx + 1,
              total: detectedAnnotations.length
            });
          }

        } catch (error) {
          totalErrors++;
          this.logger?.error('Failed to emit event', { referenceId, error });
          // Continue processing other entities even if one fails
        }
      }

      this.logger?.info('Completed entity type processing', {
        entityType,
        found: detectedAnnotations.length,
        emitted: detectedAnnotations.length - (totalErrors - (totalFound - totalEmitted))
      });

      // Update progress after processing this entity type
      updatedJob = {
        ...updatedJob,
        progress: {
          totalEntityTypes: job.params.entityTypes.length,
          processedEntityTypes: i + 1,
          currentEntityType: entityType,
          entitiesFound: totalFound,
          entitiesEmitted: totalEmitted
        }
      };
      await this.updateJobProgress(updatedJob);
    }

    this.logger?.info('Detection complete', { totalFound, totalEmitted, totalErrors });

    // Return result - base class will use this for CompleteJob and emitCompletionEvent
    return {
      totalFound,
      totalEmitted,
      errors: totalErrors
    };
  }

  /**
   * Emit completion event with result data
   * Override base class to emit job.completed event (domain + progress)
   */
  protected override async emitCompletionEvent(
    job: RunningJob<DetectionParams, DetectionProgress>,
    result: DetectionResult
  ): Promise<void> {
    // DOMAIN EVENT: Write to EventStore (auto-publishes to EventBus)
    await this.eventStore.appendEvent({
      type: 'job.completed',
      resourceId: job.params.resourceId,
      userId: job.metadata.userId,
      version: 1,
      payload: {
        jobId: job.metadata.id,
        jobType: 'reference-annotation',
        result,
      },
    });

    // Domain event (job.completed) is automatically published to EventBus by EventStore
    // Backend SSE endpoint will subscribe to job.completed and transform to annotate:detect-finished
  }

  protected override async handleJobFailure(job: AnyJob, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, emit job.failed event
    if (job.status === 'failed' && job.metadata.type === 'reference-annotation') {
      // Type narrowing: job is FailedJob<DetectionParams>
      const detJob = job as DetectionJob;

      // DOMAIN EVENT: Write to EventStore (auto-publishes to EventBus)
      await this.eventStore.appendEvent({
        type: 'job.failed',
        resourceId: detJob.params.resourceId,
        userId: detJob.metadata.userId,
        version: 1,
        payload: {
          jobId: detJob.metadata.id,
          jobType: detJob.metadata.type,
          error: 'Entity detection failed. Please try again later.',
        },
      });

      // Domain event (job.failed) is automatically published to EventBus by EventStore
      // Backend SSE endpoint will subscribe to job.failed and transform to annotate:detect-failed
    }
  }

  /**
   * Update job progress and emit events to Event Store and EventBus
   * Overrides base class to emit both domain events and progress events
   */
  protected override async updateJobProgress(job: AnyJob): Promise<void> {
    // Call parent to update job queue
    await super.updateJobProgress(job);

    // Emit events for detection jobs
    if (job.metadata.type !== 'reference-annotation') {
      return;
    }

    // Type guard: only running jobs have progress
    if (job.status !== 'running') {
      return;
    }

    const detJob = job as RunningJob<DetectionParams, DetectionProgress>;

    const baseEvent = {
      resourceId: detJob.params.resourceId,
      userId: detJob.metadata.userId,
      version: 1,
    };

    // Determine if this is the first progress update (job.started)
    const isFirstUpdate = detJob.progress.processedEntityTypes === 0;

    // Get resource-scoped EventBus for progress events
    const resourceBus = this.eventBus.scope(detJob.params.resourceId);

    if (isFirstUpdate) {
      // First progress update - emit job.started (domain event)
      await this.eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: detJob.metadata.id,
          jobType: detJob.metadata.type,
          totalSteps: detJob.params.entityTypes.length,
        },
      });

      // Domain event (job.started) is automatically published to EventBus by EventStore
      // Backend SSE endpoint will subscribe to job.started and transform to stream events
    } else {
      // Intermediate progress - emit job.progress (domain event)
      const percentage = Math.round((detJob.progress.processedEntityTypes / detJob.progress.totalEntityTypes) * 100);
      await this.eventStore.appendEvent({
        type: 'job.progress',
        ...baseEvent,
        payload: {
          jobId: detJob.metadata.id,
          jobType: detJob.metadata.type,
          percentage,
          currentStep: detJob.progress.currentEntityType,
          processedSteps: detJob.progress.processedEntityTypes,
          totalSteps: detJob.progress.totalEntityTypes,
          foundCount: detJob.progress.entitiesFound,
        },
      });

      // PROGRESS EVENT: Emit annotate:progress directly to EventBus (ephemeral)
      resourceBus.get('annotate:progress').next({
        status: 'scanning',
        message: `Processing ${detJob.progress.currentEntityType}`,
        currentEntityType: detJob.progress.currentEntityType,
        percentage,
      });
    }
  }
}
