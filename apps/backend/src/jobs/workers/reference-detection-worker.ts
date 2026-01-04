/**
 * Reference Detection Worker
 *
 * Processes detection jobs: runs AI inference to find entities in resources
 * and emits reference.created events for each detected entity.
 *
 * This worker is INDEPENDENT of HTTP clients - it just processes jobs and emits events.
 */

import { JobWorker } from '@semiont/jobs';
import type { Job, DetectionJob } from '@semiont/jobs';
import { ResourceQueryService } from '../../services/resource-queries';
import { createEventStore } from '../../services/event-store-service';
import { generateAnnotationId } from '../../utils/id-generator';
import { resourceIdToURI } from '@semiont/core';
import type { EnvironmentConfig } from '@semiont/core';
import {
  type components,
  getPrimaryRepresentation,
  decodeRepresentation,
  validateAndCorrectOffsets,
} from '@semiont/api-client';
import { extractEntities } from '../../inference/entity-extractor';
import { FilesystemRepresentationStore } from '../../storage/representation/representation-store';

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
  constructor(private config: EnvironmentConfig) {
    super();
  }

  protected getWorkerName(): string {
    return 'ReferenceDetectionWorker';
  }

  protected canProcessJob(job: Job): boolean {
    return job.type === 'detection';
  }

  protected async executeJob(job: Job): Promise<void> {
    if (job.type !== 'detection') {
      throw new Error(`Invalid job type: ${job.type}`);
    }

    await this.processDetectionJob(job);
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

  private async processDetectionJob(job: DetectionJob): Promise<void> {
    console.log(`[ReferenceDetectionWorker] Processing detection for resource ${job.resourceId} (job: ${job.id})`);
    console.log(`[ReferenceDetectionWorker] 🔍 Entity types: ${job.entityTypes.join(', ')}`);

    // Fetch resource content
    const resource = await ResourceQueryService.getResourceMetadata(job.resourceId, this.config);

    if (!resource) {
      throw new Error(`Resource ${job.resourceId} not found`);
    }

    let totalFound = 0;
    let totalEmitted = 0;
    let totalErrors = 0;

    // Emit job.started before processing
    job.progress = {
      totalEntityTypes: job.entityTypes.length,
      processedEntityTypes: 0,
      entitiesFound: 0,
      entitiesEmitted: 0
    };
    await this.updateJobProgress(job);

    // Process each entity type
    for (let i = 0; i < job.entityTypes.length; i++) {
      const entityType = job.entityTypes[i];

      if (!entityType) continue;

      console.log(`[ReferenceDetectionWorker] 🤖 [${i + 1}/${job.entityTypes.length}] Detecting ${entityType}...`);

      // Detect entities using AI (loads content from filesystem internally)
      const detectedAnnotations = await this.detectReferences(resource, [entityType], job.includeDescriptiveReferences);

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
          job.status = 'failed';
          job.error = 'Configuration error: Backend publicURL not set';
          await this.updateJobProgress(job);
          return;
        }

        try {
          const eventStore = await createEventStore( this.config);
          await eventStore.appendEvent({
            type: 'annotation.added',
            resourceId: job.resourceId,
            userId: job.userId,
            version: 1,
            payload: {
              annotation: {
                '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
                'type': 'Annotation' as const,
                id: referenceId,
                motivation: 'linking' as const,
                target: {
                  source: resourceIdToURI(job.resourceId, this.config.services.backend!.publicURL), // Convert to full URI
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
      job.progress = {
        totalEntityTypes: job.entityTypes.length,
        processedEntityTypes: i + 1,
        currentEntityType: entityType,
        entitiesFound: totalFound,
        entitiesEmitted: totalEmitted
      };
      await this.updateJobProgress(job);
    }

    // Set final result
    job.result = {
      totalFound,
      totalEmitted,
      errors: totalErrors
    };

    console.log(`[ReferenceDetectionWorker] ✅ Detection complete: ${totalFound} entities found, ${totalEmitted} events emitted, ${totalErrors} errors`);
  }

  protected override async handleJobFailure(job: Job, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, emit job.failed event
    if (job.status === 'failed' && job.type === 'detection') {
      const detJob = job as DetectionJob;
      const eventStore = await createEventStore(this.config);

      // Log the full error details to backend logs (already logged by parent)
      // Send generic error message to frontend
      await eventStore.appendEvent({
        type: 'job.failed',
        resourceId: detJob.resourceId,
        userId: detJob.userId,
        version: 1,
        payload: {
          jobId: detJob.id,
          jobType: detJob.type,
          error: 'Entity detection failed. Please try again later.',
        },
      });
    }
  }

  /**
   * Update job progress and emit events to Event Store
   * Overrides base class to also emit job progress events
   */
  protected override async updateJobProgress(job: Job): Promise<void> {
    // Call parent to update job queue
    await super.updateJobProgress(job);

    // Emit events for detection jobs
    if (job.type !== 'detection') {
      return;
    }

    const detJob = job as DetectionJob;
    const eventStore = await createEventStore( this.config);

    const baseEvent = {
      resourceId: detJob.resourceId,
      userId: detJob.userId,
      version: 1,
    };

    // Require progress object to be present
    if (!detJob.progress) {
      return;
    }

    // Determine if this is the first progress update (job.started)
    const isFirstUpdate = detJob.progress.processedEntityTypes === 0;

    // Determine if this is the final update (job.completed)
    const isFinalUpdate =
      detJob.progress.processedEntityTypes === detJob.progress.totalEntityTypes &&
      detJob.progress.totalEntityTypes > 0;

    if (isFirstUpdate) {
      // First progress update - emit job.started
      await eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: detJob.id,
          jobType: detJob.type,
          totalSteps: detJob.entityTypes.length,
        },
      });
    } else if (isFinalUpdate) {
      // Final progress update - emit job.completed
      await eventStore.appendEvent({
        type: 'job.completed',
        ...baseEvent,
        payload: {
          jobId: detJob.id,
          jobType: detJob.type,
          foundCount: detJob.progress.entitiesFound,
        },
      });
    } else {
      // Intermediate progress - emit job.progress
      const percentage = Math.round((detJob.progress.processedEntityTypes / detJob.progress.totalEntityTypes) * 100);
      await eventStore.appendEvent({
        type: 'job.progress',
        ...baseEvent,
        payload: {
          jobId: detJob.id,
          jobType: detJob.type,
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
