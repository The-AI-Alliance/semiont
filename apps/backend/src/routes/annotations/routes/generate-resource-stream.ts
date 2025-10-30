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
import type { AnnotationsRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { getExactText, compareAnnotationIds } from '@semiont/api-client';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { getJobQueue } from '../../../jobs/job-queue';
import type { GenerationJob } from '../../../jobs/types';
import { nanoid } from 'nanoid';
import { getTargetSelector } from '../../../lib/annotation-utils';
import { getEntityTypes } from '@semiont/api-client';
import { createEventStore } from '../../../services/event-store-service';
import { getFilesystemConfig } from '../../../config/environment-loader';
import type { JobProgressEvent, JobCompletedEvent, JobFailedEvent } from '@semiont/core';

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

export function registerGenerateResourceStream(router: AnnotationsRouterType) {
  /**
   * POST /api/annotations/:id/generate-resource-stream
   *
   * Generate a resource from an annotation with streaming progress updates via SSE
   * Requires authentication
   * Validates request body against GenerateResourceStreamRequest schema
   * Returns SSE stream with progress updates
   */
  router.post('/api/annotations/:id/generate-resource-stream',
    validateRequestBody('GenerateResourceStreamRequest'),
    async (c) => {
      const { id: referenceId } = c.req.param();
      const body = c.get('validatedBody') as GenerateResourceStreamRequest;

      console.log('[GenerateResourceStream] Received request body:', body);

      // User will be available from auth middleware
      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      console.log(`[GenerateResource] Starting generation for reference ${referenceId} in resource ${body.resourceId}`);
      console.log(`[GenerateResource] Locale from request:`, body.language);

      // Validate annotation exists using Layer 3
      const projection = await AnnotationQueryService.getResourceAnnotations(body.resourceId);

      // Debug: log what annotations exist
      const linkingAnnotations = projection.annotations.filter((a: any) => a.motivation === 'linking');
      console.log(`[GenerateResource] Found ${linkingAnnotations.length} linking annotations in resource`);
      linkingAnnotations.forEach((a: any, i: number) => {
        console.log(`  [${i}] id: ${a.id}`);
      });

      // Compare by ID portion (handle both URI and simple ID formats)
      const reference = projection.annotations.find((a: any) =>
        compareAnnotationIds(a.id, referenceId) && a.motivation === 'linking'
      );

      if (!reference) {
        throw new HTTPException(404, { message: `Reference ${referenceId} not found in resource ${body.resourceId}` });
      }

      // Create a generation job (this decouples event emission from HTTP client)
      const jobQueue = getJobQueue();
      const job: GenerationJob = {
        id: `job-${nanoid()}`,
        type: 'generation',
        status: 'pending',
        userId: user.id,
        referenceId,
        sourceResourceId: body.resourceId,
        title: body.title,
        prompt: body.prompt,
        language: body.language,
        entityTypes: getEntityTypes(reference),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      };

      await jobQueue.createJob(job);
      console.log(`[GenerateResource] Created job ${job.id} for reference ${referenceId}`);
      console.log(`[GenerateResource] Job includes locale:`, job.language);

      // Determine resource name for progress messages
      const targetSelector = getTargetSelector(reference.target);
      const resourceName = body.title || (targetSelector ? getExactText(targetSelector) : '') || 'New Resource';

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
              resourceName,
              percentage: 0,
              message: 'Starting...'
            } as GenerationProgress),
            event: 'generation-started',
            id: String(Date.now())
          });

          // Subscribe to Event Store for job progress events
          // The job worker processes independently - if client disconnects, job continues
          const basePath = getFilesystemConfig().path;
          const eventStore = await createEventStore(basePath);

          // Promise that resolves when the job is done (complete or failed)
          let jobDoneResolver: (() => void) | null = null;
          const jobDonePromise = new Promise<void>((resolve) => {
            jobDoneResolver = resolve;
          });

          // Map event progress steps to SSE status
          const statusMap: Record<string, GenerationProgress['status']> = {
            'fetching': 'fetching',
            'generating': 'generating',
            'creating': 'creating',
            'linking': 'creating'
          };

          // Subscribe to all events for the source resource
          const subscription = eventStore.subscriptions.subscribe(body.resourceId, async (storedEvent) => {
            const event = storedEvent.event;

            // Filter events for this specific job
            if (event.type === 'job.progress' && event.payload.jobId === job.id) {
              const progressEvent = event as JobProgressEvent;
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: statusMap[progressEvent.payload.currentStep || ''] || 'generating',
                    referenceId,
                    resourceName,
                    percentage: progressEvent.payload.percentage,
                    message: progressEvent.payload.message || 'Processing...'
                  } as GenerationProgress),
                  event: 'generation-progress',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (sseError) {
                console.warn(`[GenerateResource] Client disconnected, but job ${job.id} will continue processing`);
                subscription.unsubscribe();
                if (jobDoneResolver) jobDoneResolver();
              }
            }

            // Handle job completion
            if (event.type === 'job.completed' && event.payload.jobId === job.id) {
              const completedEvent = event as JobCompletedEvent;
              await stream.writeSSE({
                data: JSON.stringify({
                  status: 'complete',
                  referenceId,
                  resourceName,
                  resourceId: completedEvent.payload.resultResourceId,
                  sourceResourceId: body.resourceId,
                  percentage: 100,
                  message: completedEvent.payload.message || 'Draft resource created! Ready for review.'
                } as GenerationProgress),
                event: 'generation-complete',
                id: storedEvent.metadata.sequenceNumber.toString()
              });
              subscription.unsubscribe();
              if (jobDoneResolver) jobDoneResolver();
            }

            // Handle job failure
            if (event.type === 'job.failed' && event.payload.jobId === job.id) {
              const failedEvent = event as JobFailedEvent;
              await stream.writeSSE({
                data: JSON.stringify({
                  status: 'error',
                  referenceId,
                  percentage: 0,
                  message: failedEvent.payload.error || 'Generation failed'
                } as GenerationProgress),
                event: 'generation-error',
                id: storedEvent.metadata.sequenceNumber.toString()
              });
              subscription.unsubscribe();
              if (jobDoneResolver) jobDoneResolver();
            }
          });

          // Keep the connection alive until the job is done
          await jobDonePromise;

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
            console.warn(`[GenerateResource] Could not send error to client (disconnected), but job ${job.id} status is preserved`);
          }
        }
      });
    }
  );
}
