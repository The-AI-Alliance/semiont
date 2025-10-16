/**
 * Generation Worker
 *
 * Processes generation jobs: runs AI inference to generate new documents
 * and emits document.created and reference.resolved events.
 *
 * This worker is INDEPENDENT of HTTP clients - it just processes jobs and emits events.
 */

import { JobWorker } from './job-worker';
import type { Job, GenerationJob } from '../types';
import { getStorageService } from '../../storage/filesystem';
import { AnnotationQueryService } from '../../services/annotation-queries';
import { DocumentQueryService } from '../../services/document-queries';
import { generateDocumentFromTopic } from '../../inference/factory';
import { CREATION_METHODS } from '@semiont/core';
import { calculateChecksum } from '@semiont/core';
import { getEventStore } from '../../events/event-store';
import { getExactText, compareAnnotationIds } from '@semiont/core';

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

    const storage = getStorageService();

    // Update progress: fetching
    job.progress = {
      stage: 'fetching',
      percentage: 20,
      message: 'Fetching source document...'
    };
    console.log(`[GenerationWorker] 📥 ${job.progress.message}`);
    await this.updateJobProgress(job);

    // Fetch reference from Layer 3
    const projection = await AnnotationQueryService.getDocumentAnnotations(job.sourceDocumentId);
    // Compare by ID portion (handle both URI and simple ID formats)
    const reference = projection.references.find((r: any) =>
      compareAnnotationIds(r.id, job.referenceId)
    );

    if (!reference) {
      throw new Error(`Reference ${job.referenceId} not found in document ${job.sourceDocumentId}`);
    }

    const sourceDocument = await DocumentQueryService.getDocumentMetadata(job.sourceDocumentId);
    if (!sourceDocument) {
      throw new Error(`Source document ${job.sourceDocumentId} not found`);
    }

    // Determine document name
    const documentName = job.title || getExactText(reference.target.selector) || 'New Document';
    console.log(`[GenerationWorker] Generating document: "${documentName}"`);

    // Update progress: generating
    job.progress = {
      stage: 'generating',
      percentage: 40,
      message: 'Creating content with AI...'
    };
    console.log(`[GenerationWorker] 🤖 ${job.progress.message}`);
    await this.updateJobProgress(job);

    // Generate content using AI
    const prompt = job.prompt || `Create a comprehensive document about "${documentName}"`;
    const generatedContent = await generateDocumentFromTopic(
      documentName,
      job.entityTypes || reference.body.entityTypes || [],
      prompt,
      job.locale
    );

    console.log(`[GenerationWorker] ✅ Generated ${generatedContent.content.length} bytes of content`);

    // Update progress: creating
    job.progress = {
      stage: 'generating',
      percentage: 70,
      message: 'Content ready, creating document...'
    };
    await this.updateJobProgress(job);

    // Calculate checksum and document ID
    const checksum = calculateChecksum(generatedContent.content);
    const documentId = `doc-sha256:${checksum}`;

    // Update progress: creating
    job.progress = {
      stage: 'creating',
      percentage: 85,
      message: 'Saving document...'
    };
    console.log(`[GenerationWorker] 💾 ${job.progress.message}`);
    await this.updateJobProgress(job);

    // Save content to Layer 1 (filesystem)
    await storage.saveDocument(documentId, Buffer.from(generatedContent.content));
    console.log(`[GenerationWorker] ✅ Saved document to filesystem: ${documentId}`);

    // Emit document.created event
    const eventStore = await getEventStore();
    await eventStore.appendEvent({
      type: 'document.created',
      documentId,
      userId: job.userId,
      version: 1,
      payload: {
        name: documentName,
        format: 'text/markdown',
        contentHash: checksum,
        creationMethod: CREATION_METHODS.GENERATED,
        entityTypes: job.entityTypes || reference.body.entityTypes || [],
        metadata: {
          isDraft: true,
          generatedFrom: job.referenceId,
          locale: job.locale,
        },
      },
    });
    console.log(`[GenerationWorker] Emitted document.created event for ${documentId}`);

    // Update progress: linking
    job.progress = {
      stage: 'linking',
      percentage: 95,
      message: 'Linking reference...'
    };
    console.log(`[GenerationWorker] 🔗 ${job.progress.message}`);
    await this.updateJobProgress(job);

    // Emit reference.resolved event to link the reference to the new document
    await eventStore.appendEvent({
      type: 'reference.resolved',
      documentId: job.sourceDocumentId,
      userId: job.userId,
      version: 1,
      payload: {
        referenceId: job.referenceId,
        targetDocumentId: documentId,
      },
    });
    console.log(`[GenerationWorker] ✅ Emitted reference.resolved event linking ${job.referenceId} → ${documentId}`);

    // Set final result
    job.result = {
      documentId,
      documentName
    };

    job.progress = {
      stage: 'linking',
      percentage: 100,
      message: 'Complete!'
    };
    await this.updateJobProgress(job);

    console.log(`[GenerationWorker] ✅ Generation complete: created document ${documentId}`);
  }
}
