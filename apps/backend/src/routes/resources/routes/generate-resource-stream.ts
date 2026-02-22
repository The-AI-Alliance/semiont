/**
 * Generate Resource Stream Route - EventBus Version
 *
 * Uses @semiont/core EventBus for real-time progress:
 * - No polling loops (previously 500ms intervals)
 * - Subscribes to generation:* events from EventBus
 * - <50ms latency for progress updates
 * - Resource-scoped event isolation
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
import type { components } from '@semiont/core';
import { getExactText } from '@semiont/api-client';
import { AnnotationContext } from '@semiont/make-meaning';
import type { JobQueue, PendingJob, GenerationParams } from '@semiont/jobs';
import { nanoid } from 'nanoid';
import { getTargetSelector } from '@semiont/api-client';
import { jobId, entityType } from '@semiont/core';
import { userId, resourceId, annotationId as makeAnnotationId } from '@semiont/core';
import { getEntityTypes } from '@semiont/ontology';

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

export function registerGenerateResourceStream(router: ResourcesRouterType, jobQueue: JobQueue) {
  /**
   * POST /resources/:resourceId/annotations/:annotationId/generate-resource-stream
   *
   * Generate a resource from an annotation with streaming progress updates via SSE
   * Requires authentication
   * Validates request body against GenerateResourceStreamRequest schema
   * Returns SSE stream with progress updates
   *
   * Event-Driven Architecture:
   * - Creates generation job
   * - Subscribes to Event Store for job.* events
   * - Forwards events to client as SSE
   * - <50ms latency (no polling)
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
      const projection = await AnnotationContext.getResourceAnnotations(resourceId(resourceIdParam), config);

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

      // Get EventBus for real-time progress subscriptions
      const { eventBus } = c.get('makeMeaning');

      // Validate context is provided (required by schema)
      if (!body.context) {
        throw new HTTPException(400, { message: 'Context is required for generation' });
      }

      // Create a generation job (this decouples event emission from HTTP client)
      const job: PendingJob<GenerationParams> = {
        status: 'pending',
        metadata: {
          id: jobId(`job-${nanoid()}`),
          type: 'generation',
          userId: userId(user.id),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          referenceId: makeAnnotationId(annotationIdParam),
          sourceResourceId: resourceId(resourceIdParam),
          title: body.title,
          prompt: body.prompt,
          language: body.language,
          entityTypes: getEntityTypes(reference).map(et => entityType(et)),
          context: body.context,           // NEW - context from frontend modal
          temperature: body.temperature,   // NEW - inference parameter
          maxTokens: body.maxTokens        // NEW - inference parameter
        }
      };

      await jobQueue.createJob(job);
      console.log(`[GenerateResource] Created job ${job.metadata.id} for annotation ${annotationIdParam}`);
      console.log(`[GenerateResource] Job includes locale:`, job.params.language);

      // Determine resource name for progress messages
      const targetSelector = getTargetSelector(reference.target);
      const resourceName = body.title || (targetSelector ? getExactText(targetSelector) : '') || 'New Resource';

      // Stream job progress to the client using EventBus subscriptions
      return streamSSE(c, async (stream) => {
        // Track if stream is closed to prevent double cleanup
        let isStreamClosed = false;
        const subscriptions: Array<{ unsubscribe: () => void }> = [];
        let keepAliveInterval: NodeJS.Timeout | null = null;
        let closeStreamCallback: (() => void) | null = null;

        // Return a Promise that only resolves when the stream should close
        // This prevents streamSSE from auto-closing the stream
        const streamPromise = new Promise<void>((resolve) => {
          closeStreamCallback = resolve;
        });

        // Centralized cleanup function
        const cleanup = () => {
          if (isStreamClosed) return;
          isStreamClosed = true;

          if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
          }

          subscriptions.forEach(sub => sub.unsubscribe());

          // Close the stream by resolving the promise
          if (closeStreamCallback) {
            closeStreamCallback();
          }
        };

        try {
          // Create resource-scoped EventBus for this resource
          // Workers emit generation:started, generation:progress, generation:completed
          const resourceBus = eventBus.scope(resourceIdParam);
          console.log(`[GenerateResource] Subscribing to EventBus for resource ${resourceIdParam}`);

          // Subscribe to generation:started
          subscriptions.push(
            resourceBus.get('generation:started').subscribe(async (_event) => {
              if (isStreamClosed) return;
              console.log(`[GenerateResource] Generation started for resource ${resourceIdParam}`);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'started',
                    referenceId: reference.id,
                    resourceName,
                    percentage: 0,
                    message: 'Starting...'
                  } as GenerationProgress),
                  event: 'generation:started',
                  id: String(Date.now())
                });
              } catch (error) {
                console.warn(`[GenerateResource] Client disconnected during start`);
                cleanup();
              }
            })
          );

          // Subscribe to generation:progress
          subscriptions.push(
            resourceBus.get('generation:progress').subscribe(async (progress) => {
              if (isStreamClosed) return;
              console.log(`[GenerateResource] Generation progress for resource ${resourceIdParam}:`, progress);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: progress.status,
                    referenceId: reference.id,
                    resourceName,
                    percentage: progress.percentage || 0,
                    message: progress.message || `${progress.status}...`
                  } as GenerationProgress),
                  event: 'generation:progress',
                  id: String(Date.now())
                });
              } catch (error) {
                console.warn(`[GenerateResource] Client disconnected during progress`);
                cleanup();
              }
            })
          );

          // Subscribe to generation:completed
          subscriptions.push(
            resourceBus.get('generation:completed').subscribe(async (event) => {
              if (isStreamClosed) return;
              console.log(`[GenerateResource] Generation completed for resource ${resourceIdParam}`);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'complete',
                    referenceId: reference.id,
                    resourceName,
                    resourceId: event.payload.resultResourceId,
                    sourceResourceId: resourceIdParam,
                    percentage: 100,
                    message: 'Draft resource created! Ready for review.'
                  } as GenerationProgress),
                  event: 'generation:complete',
                  id: String(Date.now())
                });
              } catch (error) {
                console.warn(`[GenerateResource] Client disconnected after completion`);
              }
              cleanup();
            })
          );

          // Keep-alive ping every 30 seconds
          keepAliveInterval = setInterval(async () => {
            if (isStreamClosed) {
              if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
              }
              return;
            }

            try {
              await stream.writeSSE({
                data: ':keep-alive',
              });
            } catch (error) {
              cleanup();
            }
          }, 30000);

          // Cleanup on disconnect
          c.req.raw.signal.addEventListener('abort', () => {
            console.log(`[GenerateResource] Client disconnected from generation stream for annotation ${annotationIdParam}, job ${job.metadata.id} will continue`);
            cleanup();
          });

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
              event: 'generation:failed',
              id: String(Date.now())
            });
          } catch (sseError) {
            // Client already disconnected
            console.warn(`[GenerateResource] Could not send error to client (disconnected), job ${job.metadata.id} status is preserved`);
          }
          cleanup();
        }

        // Return promise that resolves when stream should close
        // This keeps the SSE connection open until cleanup() is called
        return streamPromise;
      });
    }
  );
}
