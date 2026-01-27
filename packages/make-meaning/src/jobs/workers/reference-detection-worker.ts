/**
 * Reference Detection Worker
 *
 * Processes detection jobs: runs AI inference to find entities in resources
 * and emits reference.created events for each detected entity.
 *
 * This worker is INDEPENDENT of HTTP clients - it just processes jobs and emits events.
 */

import { JobWorker } from '@semiont/jobs';
import type { AnyJob, DetectionJob, JobQueue, RunningJob, DetectionParams, DetectionProgress } from '@semiont/jobs';
import { ResourceContext } from '../..';
import { EventStore, generateAnnotationId } from '@semiont/event-sourcing';
import { resourceIdToURI } from '@semiont/core';
import type { EnvironmentConfig } from '@semiont/core';
import {
  type components,
  getPrimaryRepresentation,
  decodeRepresentation,
  validateAndCorrectOffsets,
} from '@semiont/api-client';
import { extractEntities } from '@semiont/inference';
import { FilesystemRepresentationStore } from '@semiont/content';

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
    private eventStore: EventStore
  ) {
    super(jobQueue);
  }

  protected getWorkerName(): string {
    return 'ReferenceDetectionWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'detection';
  }

  protected async executeJob(job: AnyJob): Promise<void> {
    if (job.metadata.type !== 'detection') {
      throw new Error(`Invalid job type: ${job.metadata.type}`);
    }

    // Type guard: job must be running to execute
    if (job.status !== 'running') {
      throw new Error(`Job must be in running state to execute, got: ${job.status}`);
    }

    await this.processDetectionJob(job as RunningJob<DetectionParams, DetectionProgress>);
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
    console.log(`Detecting entities of types: ${entityTypes.join(', ')}${includeDescriptiveReferences ? ' (including descriptive references)' : ''}`);

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
      const extractedEntities = await extractEntities(content, entityTypes, this.config, includeDescriptiveReferences);

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
          console.warn(`[ReferenceDetectionWorker] Skipping invalid entity "${entity.exact}":`, error);
          // Skip this entity - AI hallucinated text that doesn't exist
        }
      }
    }

    return detectedAnnotations;
  }

  private async processDetectionJob(job: RunningJob<DetectionParams, DetectionProgress>): Promise<void> {
    console.log(`[ReferenceDetectionWorker] Processing detection for resource ${job.params.resourceId} (job: ${job.metadata.id})`);
    console.log(`[ReferenceDetectionWorker] 🔍 Entity types: ${job.params.entityTypes.join(', ')}`);

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

      console.log(`[ReferenceDetectionWorker] 🤖 [${i + 1}/${job.params.entityTypes.length}] Detecting ${entityType}...`);

      // Detect entities using AI (loads content from filesystem internally)
      const detectedAnnotations = await this.detectReferences(resource, [entityType], job.params.includeDescriptiveReferences);

      totalFound += detectedAnnotations.length;
      console.log(`[ReferenceDetectionWorker] ✅ Found ${detectedAnnotations.length} ${entityType} entities`);

      // Emit events for each detected entity
      // This happens INDEPENDENT of any HTTP client!
      for (let idx = 0; idx < detectedAnnotations.length; idx++) {
        const detected = detectedAnnotations[idx];

        if (!detected) {
          console.warn(`[ReferenceDetectionWorker] Skipping undefined entity at index ${idx}`);
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
          console.error(`[ReferenceDetectionWorker] Failed to generate annotation ID:`, error);
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
            console.log(`[ReferenceDetectionWorker] 📤 Emitted ${idx + 1}/${detectedAnnotations.length} events for ${entityType}`);
          }

        } catch (error) {
          totalErrors++;
          console.error(`[ReferenceDetectionWorker] ❌ Failed to emit event for ${referenceId}:`, error);
          // Continue processing other entities even if one fails
        }
      }

      console.log(`[ReferenceDetectionWorker] ✅ Completed ${entityType}: ${detectedAnnotations.length} found, ${detectedAnnotations.length - (totalErrors - (totalFound - totalEmitted))} emitted`);

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

    console.log(`[ReferenceDetectionWorker] ✅ Detection complete: ${totalFound} entities found, ${totalEmitted} events emitted, ${totalErrors} errors`);

    // Note: JobWorker base class will create the CompleteJob with result
    // We don't set job.result here - that's handled by the base class
  }

  protected override async handleJobFailure(job: AnyJob, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, emit job.failed event
    if (job.status === 'failed' && job.metadata.type === 'detection') {
      // Type narrowing: job is FailedJob<DetectionParams>
      const detJob = job as DetectionJob;

      // Log the full error details to backend logs (already logged by parent)
      // Send generic error message to frontend
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
    }
  }

  /**
   * Update job progress and emit events to Event Store
   * Overrides base class to also emit job progress events
   */
  protected override async updateJobProgress(job: AnyJob): Promise<void> {
    // Call parent to update job queue
    await super.updateJobProgress(job);

    // Emit events for detection jobs
    if (job.metadata.type !== 'detection') {
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

    // Determine if this is the final update (job.completed)
    const isFinalUpdate =
      detJob.progress.processedEntityTypes === detJob.progress.totalEntityTypes &&
      detJob.progress.totalEntityTypes > 0;

    if (isFirstUpdate) {
      // First progress update - emit job.started
      await this.eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: detJob.metadata.id,
          jobType: detJob.metadata.type,
          totalSteps: detJob.params.entityTypes.length,
        },
      });
    } else if (isFinalUpdate) {
      // Final progress update - emit job.completed
      await this.eventStore.appendEvent({
        type: 'job.completed',
        ...baseEvent,
        payload: {
          jobId: detJob.metadata.id,
          jobType: detJob.metadata.type,
          foundCount: detJob.progress.entitiesFound,
        },
      });
    } else {
      // Intermediate progress - emit job.progress
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
    }
  }
}
