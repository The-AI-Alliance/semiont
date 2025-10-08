/**
 * Detection Worker
 *
 * Processes detection jobs: runs AI inference to find entities in documents
 * and emits reference.created events for each detected entity.
 *
 * This worker is INDEPENDENT of HTTP clients - it just processes jobs and emits events.
 */

import { JobWorker } from './job-worker';
import type { Job, DetectionJob } from '../types';
import { DocumentQueryService } from '../../services/document-queries';
import { detectSelectionsInDocument } from '../../routes/documents/helpers';
import { emitReferenceCreated } from '../../events/emit';
import { generateAnnotationId } from '../../utils/id-generator';

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
    console.log(`[DetectionWorker] Processing detection for document ${job.documentId}`);
    console.log(`[DetectionWorker] Entity types: ${job.entityTypes.join(', ')}`);

    // Fetch document content
    const document = await DocumentQueryService.getDocumentMetadata(job.documentId);

    if (!document) {
      throw new Error(`Document ${job.documentId} not found`);
    }

    let totalFound = 0;
    let totalEmitted = 0;
    let totalErrors = 0;

    // Process each entity type
    for (let i = 0; i < job.entityTypes.length; i++) {
      const entityType = job.entityTypes[i];

      if (!entityType) continue;

      console.log(`[DetectionWorker] [${i + 1}/${job.entityTypes.length}] Detecting ${entityType}...`);

      // Update progress
      job.progress = {
        totalEntityTypes: job.entityTypes.length,
        processedEntityTypes: i,
        currentEntityType: entityType,
        entitiesFound: totalFound,
        entitiesEmitted: totalEmitted
      };
      await this.updateJobProgress(job);

      // Detect entities using AI (loads content from filesystem internally)
      const detectedSelections = await detectSelectionsInDocument(
        job.documentId,
        document.contentType,
        [entityType]
      );

      totalFound += detectedSelections.length;
      console.log(`[DetectionWorker] Found ${detectedSelections.length} ${entityType} entities`);

      // Emit events for each detected entity
      // This happens INDEPENDENT of any HTTP client!
      for (let idx = 0; idx < detectedSelections.length; idx++) {
        const detected = detectedSelections[idx];

        if (!detected) {
          console.warn(`[DetectionWorker] Skipping undefined entity at index ${idx}`);
          continue;
        }

        const referenceId = generateAnnotationId();

        try {
          await emitReferenceCreated({
            documentId: job.documentId,
            userId: job.userId,
            referenceId,
            exact: detected.selection.selector.exact,
            position: {
              offset: detected.selection.selector.offset,
              length: detected.selection.selector.length,
            },
            entityTypes: detected.selection.entityTypes,
            referenceType: undefined, // Unresolved reference
            targetDocumentId: undefined, // Will be resolved later
          });

          totalEmitted++;

          if ((idx + 1) % 10 === 0 || idx === detectedSelections.length - 1) {
            console.log(`[DetectionWorker] Emitted ${idx + 1}/${detectedSelections.length} events for ${entityType}`);
          }

        } catch (error) {
          totalErrors++;
          console.error(`[DetectionWorker] Failed to emit event for ${referenceId}:`, error);
          // Continue processing other entities even if one fails
        }
      }

      console.log(`[DetectionWorker] ✅ Completed ${entityType}: ${detectedSelections.length} found, ${detectedSelections.length - (totalErrors - (totalFound - totalEmitted))} emitted`);
    }

    // Set final result
    job.result = {
      totalFound,
      totalEmitted,
      errors: totalErrors
    };

    job.progress = {
      totalEntityTypes: job.entityTypes.length,
      processedEntityTypes: job.entityTypes.length,
      entitiesFound: totalFound,
      entitiesEmitted: totalEmitted
    };

    await this.updateJobProgress(job);

    console.log(`[DetectionWorker] ✅ Detection complete: ${totalFound} entities found, ${totalEmitted} events emitted, ${totalErrors} errors`);
  }
}
