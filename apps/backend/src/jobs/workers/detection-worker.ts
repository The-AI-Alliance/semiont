/**
 * Detection Worker
 *
 * Processes detection jobs: runs AI inference to find entities in resources
 * and emits reference.created events for each detected entity.
 *
 * This worker is INDEPENDENT of HTTP clients - it just processes jobs and emits events.
 */

import { JobWorker } from './job-worker';
import type { Job, DetectionJob } from '../types';
import { ResourceQueryService } from '../../services/resource-queries';
import { detectAnnotationsInResource } from '../../routes/resources/helpers';
import { createEventStore } from '../../services/event-store-service';
import { generateAnnotationId } from '../../utils/id-generator';
import { resourceIdToURI } from '../../lib/uri-utils';
import type { EnvironmentConfig } from '@semiont/core';

export class DetectionWorker extends JobWorker {
  constructor(private config: EnvironmentConfig) {
    super();
  }

  protected getWorkerName(): string {
    return 'DetectionWorker';
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

  private async processDetectionJob(job: DetectionJob): Promise<void> {
    console.log(`[DetectionWorker] Processing detection for resource ${job.resourceId} (job: ${job.id})`);
    console.log(`[DetectionWorker] 🔍 Entity types: ${job.entityTypes.join(', ')}`);

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

      console.log(`[DetectionWorker] 🤖 [${i + 1}/${job.entityTypes.length}] Detecting ${entityType}...`);

      // Detect entities using AI (loads content from filesystem internally)
      const detectedAnnotations = await detectAnnotationsInResource(
        resource,
        [entityType],
        this.config
      );

      totalFound += detectedAnnotations.length;
      console.log(`[DetectionWorker] ✅ Found ${detectedAnnotations.length} ${entityType} entities`);

      // Emit events for each detected entity
      // This happens INDEPENDENT of any HTTP client!
      for (let idx = 0; idx < detectedAnnotations.length; idx++) {
        const detected = detectedAnnotations[idx];

        if (!detected) {
          console.warn(`[DetectionWorker] Skipping undefined entity at index ${idx}`);
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
          console.error(`[DetectionWorker] Failed to generate annotation ID:`, error);
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
            console.log(`[DetectionWorker] 📤 Emitted ${idx + 1}/${detectedAnnotations.length} events for ${entityType}`);
          }

        } catch (error) {
          totalErrors++;
          console.error(`[DetectionWorker] ❌ Failed to emit event for ${referenceId}:`, error);
          // Continue processing other entities even if one fails
        }
      }

      console.log(`[DetectionWorker] ✅ Completed ${entityType}: ${detectedAnnotations.length} found, ${detectedAnnotations.length - (totalErrors - (totalFound - totalEmitted))} emitted`);

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

    console.log(`[DetectionWorker] ✅ Detection complete: ${totalFound} entities found, ${totalEmitted} events emitted, ${totalErrors} errors`);
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
