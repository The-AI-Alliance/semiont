/**
 * Generate Document Stream Route - Spec-First Version
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
import type { AnnotationsRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { getJobQueue } from '../../../jobs/job-queue';
import type { GenerationJob } from '../../../jobs/types';
import { nanoid } from 'nanoid';
import { getExactText, compareAnnotationIds } from '@semiont/core';

type GenerateDocumentStreamRequest = components['schemas']['GenerateDocumentStreamRequest'];

interface GenerationProgress {
  status: 'started' | 'fetching' | 'generating' | 'creating' | 'complete' | 'error';
  referenceId: string;
  documentName?: string;
  documentId?: string;
  sourceDocumentId?: string;
  percentage: number;
  message?: string;
}

export function registerGenerateDocumentStream(router: AnnotationsRouterType) {
  /**
   * POST /api/annotations/:id/generate-document-stream
   *
   * Generate a document from an annotation with streaming progress updates via SSE
   * Requires authentication
   * Validates request body against GenerateDocumentStreamRequest schema
   * Returns SSE stream with progress updates
   */
  router.post('/api/annotations/:id/generate-document-stream',
    validateRequestBody('GenerateDocumentStreamRequest'),
    async (c) => {
      const { id: referenceId } = c.req.param();
      const body = c.get('validatedBody') as GenerateDocumentStreamRequest;

      console.log('[GenerateDocumentStream] Received request body:', body);

      // User will be available from auth middleware
      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      console.log(`[GenerateDocument] Starting generation for reference ${referenceId} in document ${body.documentId}`);
      console.log(`[GenerateDocument] Locale from request:`, body.locale);

      // Validate annotation exists using Layer 3
      const projection = await AnnotationQueryService.getDocumentAnnotations(body.documentId);

      // Debug: log what annotations exist
      const linkingAnnotations = projection.annotations.filter((a: any) => a.motivation === 'linking');
      console.log(`[GenerateDocument] Found ${linkingAnnotations.length} linking annotations in document`);
      linkingAnnotations.forEach((a: any, i: number) => {
        console.log(`  [${i}] id: ${a.id}`);
      });

      // Compare by ID portion (handle both URI and simple ID formats)
      const reference = projection.annotations.find((a: any) =>
        compareAnnotationIds(a.id, referenceId) && a.motivation === 'linking'
      );

      if (!reference) {
        throw new HTTPException(404, { message: `Reference ${referenceId} not found in document ${body.documentId}` });
      }

      // Create a generation job (this decouples event emission from HTTP client)
      const jobQueue = getJobQueue();
      const job: GenerationJob = {
        id: `job-${nanoid()}`,
        type: 'generation',
        status: 'pending',
        userId: user.id,
        referenceId,
        sourceDocumentId: body.documentId,
        title: body.title,
        prompt: body.prompt,
        locale: body.locale,
        entityTypes: reference.body.entityTypes,
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      };

      await jobQueue.createJob(job);
      console.log(`[GenerateDocument] Created job ${job.id} for reference ${referenceId}`);
      console.log(`[GenerateDocument] Job includes locale:`, job.locale);

      // Determine document name for progress messages
      const documentName = body.title || getExactText(reference.target.selector) || 'New Document';

      // Stream the job's progress to the client
      return streamSSE(c, async (stream) => {
        // Set proper SSE headers with charset
        c.header('Content-Type', 'text/event-stream; charset=utf-8');
        c.header('Cache-Control', 'no-cache');
        c.header('Connection', 'keep-alive');
        try {
          // Send initial started event
          await stream.writeSSE({
            data: JSON.stringify({
              status: 'started',
              referenceId,
              documentName,
              percentage: 0,
              message: 'Starting...'
            } as GenerationProgress),
            event: 'generation-started',
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
              if (currentJob.status === 'running' && currentJob.type === 'generation') {
                const generationJob = currentJob as GenerationJob;
                const progress = generationJob.progress;

                if (progress) {
                  // Map job progress stages to SSE status
                  const statusMap: Record<typeof progress.stage, GenerationProgress['status']> = {
                    'fetching': 'fetching',
                    'generating': 'generating',
                    'creating': 'creating',
                    'linking': 'creating'
                  };

                  try {
                    await stream.writeSSE({
                      data: JSON.stringify({
                        status: statusMap[progress.stage],
                        referenceId,
                        documentName,
                        percentage: progress.percentage,
                        message: progress.message || `${progress.stage}...`
                      } as GenerationProgress),
                      event: 'generation-progress',
                      id: String(Date.now())
                    });
                  } catch (sseError) {
                    console.warn(`[GenerateDocument] Client disconnected, but job ${job.id} will continue processing`);
                    break; // Client disconnected, stop streaming (job continues)
                  }
                }
              }

              lastStatus = currentJob.status;
              lastProgress = currentProgress;
            }

            // Check if job completed
            if (currentJob.status === 'complete') {
              const result = (currentJob as GenerationJob).result;
              await stream.writeSSE({
                data: JSON.stringify({
                  status: 'complete',
                  referenceId,
                  documentName: result?.documentName || documentName,
                  documentId: result?.documentId,
                  sourceDocumentId: body.documentId,
                  percentage: 100,
                  message: 'Draft document created! Ready for review.'
                } as GenerationProgress),
                event: 'generation-complete',
                id: String(Date.now())
              });
              break;
            }

            if (currentJob.status === 'failed') {
              await stream.writeSSE({
                data: JSON.stringify({
                  status: 'error',
                  referenceId,
                  percentage: 0,
                  message: currentJob.error || 'Generation failed'
                } as GenerationProgress),
                event: 'generation-error',
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
                referenceId,
                percentage: 0,
                message: error instanceof Error ? error.message : 'Generation failed'
              } as GenerationProgress),
              event: 'generation-error',
              id: String(Date.now())
            });
          } catch (sseError) {
            // Client already disconnected
            console.warn(`[GenerateDocument] Could not send error to client (disconnected), but job ${job.id} status is preserved`);
          }
        }
      });
    }
  );
}
