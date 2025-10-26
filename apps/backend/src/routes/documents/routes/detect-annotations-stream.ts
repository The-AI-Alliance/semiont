/**
 * Detect Annotations Stream Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request body with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 * - SSE streaming response (no response validation per SSE-VALIDATION-CONSIDERATIONS.md)
 */

import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { DocumentsRouterType } from '../shared';
import { DocumentQueryService } from '../../../services/document-queries';
import { getJobQueue } from '../../../jobs/job-queue';
import type { DetectionJob } from '../../../jobs/types';
import { nanoid } from 'nanoid';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';

type DetectAnnotationsStreamRequest = components['schemas']['DetectAnnotationsStreamRequest'];

interface DetectionProgress {
  status: 'started' | 'scanning' | 'complete' | 'error';
  documentId: string;
  currentEntityType?: string;
  totalEntityTypes: number;
  processedEntityTypes: number;
  message?: string;
  foundCount?: number;
}

export function registerDetectAnnotationsStream(router: DocumentsRouterType) {
  /**
   * POST /api/documents/:id/detect-annotations-stream
   *
   * Stream real-time entity detection progress via Server-Sent Events
   * Requires authentication
   * Validates request body against DetectAnnotationsStreamRequest schema
   * Returns SSE stream with progress updates
   */
  router.post('/api/documents/:id/detect-annotations-stream',
    validateRequestBody('DetectAnnotationsStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as DetectAnnotationsStreamRequest;
      const { entityTypes } = body;

      console.log(`[DetectAnnotations] Starting detection for document ${id} with entity types:`, entityTypes);

      // User will be available from auth middleware since this is a POST request
      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      // Validate document exists using Layer 3
      const document = await DocumentQueryService.getDocumentMetadata(id);
      if (!document) {
        throw new HTTPException(404, { message: 'Document not found in Layer 3 projections - document may need to be recreated' });
      }

      // Create a detection job (this decouples event emission from HTTP client)
      const jobQueue = getJobQueue();
      const job: DetectionJob = {
        id: `job-${nanoid()}`,
        type: 'detection',
        status: 'pending',
        userId: user.id,
        documentId: id,
        entityTypes,
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      };

      await jobQueue.createJob(job);
      console.log(`[DetectAnnotations] Created job ${job.id} for document ${id}`);

      // Stream the job's progress to the client
      return streamSSE(c, async (stream) => {
        try {
          // Send initial started event
          await stream.writeSSE({
            data: JSON.stringify({
              status: 'started',
              documentId: id,
              totalEntityTypes: entityTypes.length,
              processedEntityTypes: 0,
              message: 'Starting entity detection...'
            } as DetectionProgress),
            event: 'detection-started',
            id: String(Date.now())
          });

          let lastStatus = job.status;
          let lastProgress = JSON.stringify(job.progress);

          // Poll job status and stream updates to client
          // The job worker processes independently - if client disconnects, job continues
          while (true) {
            const currentJob = await jobQueue.getJob(job.id);

            if (!currentJob) {
              throw new Error('Job was deleted');
            }

            const currentProgress = JSON.stringify(currentJob.progress);

            // Send progress updates when job state changes
            if (currentJob.status !== lastStatus || currentProgress !== lastProgress) {
              if (currentJob.status === 'running' && currentJob.type === 'detection') {
                const detectionJob = currentJob as DetectionJob;
                const progress = detectionJob.progress;

                if (progress) {
                  // Send scanning progress
                  try {
                    await stream.writeSSE({
                      data: JSON.stringify({
                        status: 'scanning',
                        documentId: id,
                        currentEntityType: progress.currentEntityType,
                        totalEntityTypes: progress.totalEntityTypes,
                        processedEntityTypes: progress.processedEntityTypes,
                        foundCount: progress.entitiesFound,
                        message: progress.currentEntityType
                          ? `Scanning for ${progress.currentEntityType}...`
                          : 'Processing...'
                      } as DetectionProgress),
                      event: 'detection-progress',
                      id: String(Date.now())
                    });
                  } catch (sseError) {
                    console.warn(`[DetectAnnotations] Client disconnected, but job ${job.id} will continue processing`);
                    break; // Client disconnected, stop streaming (job continues)
                  }
                }
              }

              lastStatus = currentJob.status;
              lastProgress = currentProgress;
            }

            // Check if job completed
            if (currentJob.status === 'complete') {
              const result = (currentJob as DetectionJob).result;
              await stream.writeSSE({
                data: JSON.stringify({
                  status: 'complete',
                  documentId: id,
                  totalEntityTypes: entityTypes.length,
                  processedEntityTypes: entityTypes.length,
                  message: result
                    ? `Detection complete! Found ${result.totalFound} entities, emitted ${result.totalEmitted} events`
                    : 'Detection complete!'
                } as DetectionProgress),
                event: 'detection-complete',
                id: String(Date.now())
              });
              break;
            }

            if (currentJob.status === 'failed') {
              await stream.writeSSE({
                data: JSON.stringify({
                  status: 'error',
                  documentId: id,
                  totalEntityTypes: entityTypes.length,
                  processedEntityTypes: 0,
                  message: currentJob.error || 'Detection failed'
                } as DetectionProgress),
                event: 'detection-error',
                id: String(Date.now())
              });
              break;
            }

            // Poll every 500ms
            await new Promise(resolve => setTimeout(resolve, 500));
          }

        } catch (error) {
          // Send error event
          try {
            await stream.writeSSE({
              data: JSON.stringify({
                status: 'error',
                documentId: id,
                totalEntityTypes: entityTypes.length,
                processedEntityTypes: 0,
                message: error instanceof Error ? error.message : 'Detection failed'
              } as DetectionProgress),
              event: 'detection-error',
              id: String(Date.now())
            });
          } catch (sseError) {
            // Client already disconnected
            console.warn(`[DetectAnnotations] Could not send error to client (disconnected), but job ${job.id} status is preserved`);
          }
        }
      });
    }
  );
}
