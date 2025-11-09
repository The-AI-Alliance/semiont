/**
 * Generate Resource Stream Route - Spec-First Version
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
import type { ResourcesRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { getExactText } from '@semiont/api-client';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { getJobQueue } from '../../../jobs/job-queue';
import type { GenerationJob } from '../../../jobs/types';
import { nanoid } from 'nanoid';
import { getTargetSelector } from '../../../lib/annotation-utils';
import { getEntityTypes } from '@semiont/api-client';
import { jobId, entityType } from '@semiont/api-client';
import { userId, resourceId, annotationId as makeAnnotationId } from '@semiont/core';

type GenerateResourceStreamRequest = components['schemas']['GenerateResourceStreamRequest'];

interface GenerationProgress {
  status: 'started' | 'fetching' | 'generating' | 'creating' | 'complete' | 'error';
  referenceId: string;
  resourceName?: string;
  resourceId?: string;
  sourceResourceId?: string;
  percentage: number;
  message?: string;
}

export function registerGenerateResourceStream(router: ResourcesRouterType) {
  /**
   * POST /resources/:resourceId/annotations/:annotationId/generate-resource-stream
   *
   * Generate a resource from an annotation with streaming progress updates via SSE
   * Requires authentication
   * Validates request body against GenerateResourceStreamRequest schema
   * Returns SSE stream with progress updates
   */
  router.post('/resources/:resourceId/annotations/:annotationId/generate-resource-stream',
    validateRequestBody('GenerateResourceStreamRequest'),
    async (c) => {
      const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
      const body = c.get('validatedBody') as GenerateResourceStreamRequest;

      console.log('[GenerateResourceStream] Received request body:', body);

      // User will be available from auth middleware
      const user = c.get('user');
      const config = c.get('config');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      console.log(`[GenerateResource] Starting generation for annotation ${annotationIdParam} in resource ${resourceIdParam}`);
      console.log(`[GenerateResource] Locale from request:`, body.language);

      // Validate annotation exists using view storage
      const projection = await AnnotationQueryService.getResourceAnnotations(resourceId(resourceIdParam), config);

      // Debug: log what annotations exist
      const linkingAnnotations = projection.annotations.filter((a: any) => a.motivation === 'linking');
      console.log(`[GenerateResource] Found ${linkingAnnotations.length} linking annotations in resource`);
      linkingAnnotations.forEach((a: any, i: number) => {
        console.log(`  [${i}] id: ${a.id}`);
      });

      // Compare by ID - need to match full annotation URI
      const expectedAnnotationUri = `${config.services.backend!.publicURL}/annotations/${annotationIdParam}`;
      console.log(`[GenerateResource] Looking for annotation URI: ${expectedAnnotationUri}`);

      const reference = projection.annotations.find((a: any) =>
        a.id === expectedAnnotationUri && a.motivation === 'linking'
      );

      if (!reference) {
        console.log(`[GenerateResource] Annotation not found. Expected: ${expectedAnnotationUri}`);
        console.log(`[GenerateResource] Available IDs:`, projection.annotations.map((a: any) => a.id));
        throw new HTTPException(404, { message: `Annotation ${annotationIdParam} not found in resource ${resourceIdParam}` });
      }
      console.log(`[GenerateResource] Found matching annotation:`, reference.id);

      // Create a generation job (this decouples event emission from HTTP client)
      const jobQueue = getJobQueue();
      const job: GenerationJob = {
        id: jobId(`job-${nanoid()}`),
        type: 'generation',
        status: 'pending',
        userId: userId(user.id),
        referenceId: makeAnnotationId(annotationIdParam),
        sourceResourceId: resourceId(resourceIdParam),
        title: body.title,
        prompt: body.prompt,
        language: body.language,
        entityTypes: getEntityTypes(reference).map(et => entityType(et)),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      };

      await jobQueue.createJob(job);
      console.log(`[GenerateResource] Created job ${job.id} for annotation ${annotationIdParam}`);
      console.log(`[GenerateResource] Job includes locale:`, job.language);

      // Determine resource name for progress messages
      const targetSelector = getTargetSelector(reference.target);
      const resourceName = body.title || (targetSelector ? getExactText(targetSelector) : '') || 'New Resource';

      // Stream the job's progress to the client
      // Note: Hono's streamSSE automatically sets Content-Type: text/event-stream
      return streamSSE(c, async (stream) => {
        try {
          // Send initial started event
          await stream.writeSSE({
            data: JSON.stringify({
              status: 'started',
              referenceId: reference.id,
              resourceName,
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
                        referenceId: reference.id,
                        resourceName,
                        percentage: progress.percentage,
                        message: progress.message || `${progress.stage}...`
                      } as GenerationProgress),
                      event: 'generation-progress',
                      id: String(Date.now())
                    });
                  } catch (sseError) {
                    console.warn(`[GenerateResource] Client disconnected, but job ${job.id} will continue processing`);
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
                  referenceId: reference.id,
                  resourceName: result?.resourceName || resourceName,
                  resourceId: result?.resourceId,
                  sourceResourceId: resourceId(resourceIdParam),
                  percentage: 100,
                  message: 'Draft resource created! Ready for review.'
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
                  referenceId: reference.id,
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
                referenceId: reference.id,
                percentage: 0,
                message: error instanceof Error ? error.message : 'Generation failed'
              } as GenerationProgress),
              event: 'generation-error',
              id: String(Date.now())
            });
          } catch (sseError) {
            // Client already disconnected
            console.warn(`[GenerateResource] Could not send error to client (disconnected), but job ${job.id} status is preserved`);
          }
        }
      });
    }
  );
}
