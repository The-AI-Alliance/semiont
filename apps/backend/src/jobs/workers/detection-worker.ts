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
import { getFilesystemConfig } from '../../config/environment-loader';
import { resourceIdToURI } from '../../lib/uri-utils';

export class DetectionWorker extends JobWorker {
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

    const basePath = getFilesystemConfig().path;
    const eventStore = await createEventStore(basePath);

    // Emit job.started event
    await eventStore.appendEvent({
      type: 'job.started',
      resourceId: job.resourceId,
      userId: job.userId,
      version: 1,
      payload: {
        jobId: job.id,
        jobType: 'detection',
        totalSteps: job.entityTypes.length,
      },
    });

    // Fetch resource content
    const resource = await ResourceQueryService.getResourceMetadata(job.resourceId);

    if (!resource) {
      throw new Error(`Resource ${job.resourceId} not found`);
    }

    let totalFound = 0;
    let totalEmitted = 0;
    let totalErrors = 0;

    // Process each entity type
    for (let i = 0; i < job.entityTypes.length; i++) {
      const entityType = job.entityTypes[i];

      if (!entityType) continue;

      console.log(`[DetectionWorker] 🤖 [${i + 1}/${job.entityTypes.length}] Detecting ${entityType}...`);

      // Emit job.progress event to Event Store
      await eventStore.appendEvent({
        type: 'job.progress',
        resourceId: job.resourceId,
        userId: job.userId,
        version: 1,
        payload: {
          jobId: job.id,
          jobType: 'detection',
          percentage: Math.round((i / job.entityTypes.length) * 100),
          currentStep: entityType,
          processedSteps: i,
          totalSteps: job.entityTypes.length,
          foundCount: totalFound,
          message: `Scanning for ${entityType}...`,
        },
      });

      // Detect entities using AI (loads content from filesystem internally)
      const detectedAnnotations = await detectAnnotationsInResource(
        resource,
        [entityType]
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
          referenceId = generateAnnotationId();
        } catch (error) {
          console.error(`[DetectionWorker] Failed to generate annotation ID:`, error);
          throw new Error('Configuration error: BACKEND_URL not set');
        }

        try {
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
                  source: resourceIdToURI(job.resourceId), // Convert to full URI
                  selector: [
                    {
                      type: 'TextPositionSelector',
                      start: detected.annotation.selector.start,
                      end: detected.annotation.selector.end,
                    },
                    {
                      type: 'TextQuoteSelector',
                      exact: detected.annotation.selector.exact,
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
    }

    // Set final result
    job.result = {
      totalFound,
      totalEmitted,
      errors: totalErrors
    };

    // Emit job.completed event to Event Store
    if (totalErrors > 0) {
      await eventStore.appendEvent({
        type: 'job.failed',
        resourceId: job.resourceId,
        userId: job.userId,
        version: 1,
        payload: {
          jobId: job.id,
          jobType: 'detection',
          error: `Detection completed with ${totalErrors} errors`,
          details: `Found ${totalFound} entities, emitted ${totalEmitted} events, ${totalErrors} errors`,
        },
      });
    } else {
      await eventStore.appendEvent({
        type: 'job.completed',
        resourceId: job.resourceId,
        userId: job.userId,
        version: 1,
        payload: {
          jobId: job.id,
          jobType: 'detection',
          totalSteps: job.entityTypes.length,
          foundCount: totalFound,
          message: `Detection complete: ${totalFound} entities found, ${totalEmitted} events emitted`,
        },
      });
    }

    console.log(`[DetectionWorker] ✅ Detection complete: ${totalFound} entities found, ${totalEmitted} events emitted, ${totalErrors} errors`);
  }
}
