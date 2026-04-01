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
import { AnnotationContext, ResourceContext } from '@semiont/make-meaning';
import type { JobQueue, PendingJob, GenerationParams } from '@semiont/jobs';
import { nanoid } from 'nanoid';
import { getTargetSelector } from '@semiont/api-client';
import { jobId, entityType } from '@semiont/core';
import { userId, userToDid, resourceId, annotationId as makeAnnotationId } from '@semiont/core';
import { getEntityTypes } from '@semiont/ontology';
import { writeTypedSSE } from '../../../lib/sse-helpers';
import { getLogger } from '../../../logger';

type YieldResourceStreamRequest = components['schemas']['YieldResourceStreamRequest'];


export function registerYieldResourceStream(router: ResourcesRouterType, jobQueue: JobQueue) {
  /**
   * POST /resources/:resourceId/annotations/:annotationId/yield-resource-stream
   *
   * Yield a resource from an annotation with streaming progress updates via SSE
   * Requires authentication
   * Validates request body against YieldResourceStreamRequest schema
   * Returns SSE stream with progress updates
   *
   * Event-Driven Architecture:
   * - Creates generation job
   * - Subscribes to Event Store for job.* events
   * - Forwards events to client as SSE
   * - <50ms latency (no polling)
   */
  router.post('/resources/:resourceId/annotations/:annotationId/yield-resource-stream',
    validateRequestBody('YieldResourceStreamRequest'),
    async (c) => {
      const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
      const body = c.get('validatedBody') as YieldResourceStreamRequest;

      const logger = getLogger().child({
        component: 'yield-resource-stream',
        resourceId: resourceIdParam,
        annotationId: annotationIdParam
      });

      logger.info('Received generation request', { body });

      // User will be available from auth middleware
      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      const eventBus = c.get('eventBus');
      const { knowledgeSystem: { kb } } = c.get('makeMeaning');

      logger.info('Starting resource generation', { language: body.language });

      // Validate annotation exists using view storage
      const projection = await AnnotationContext.getResourceAnnotations(resourceId(resourceIdParam), kb);

      // Debug: log what annotations exist
      const linkingAnnotations = projection.annotations.filter((a: any) => a.motivation === 'linking');
      logger.info('Found linking annotations in resource', {
        count: linkingAnnotations.length,
        ids: linkingAnnotations.map((a: any) => a.id)
      });

      // Compare by bare annotation ID
      logger.info('Looking for annotation', { annotationId: annotationIdParam });

      const reference = projection.annotations.find((a: any) =>
        a.id === annotationIdParam && a.motivation === 'linking'
      );

      if (!reference) {
        logger.warn('Annotation not found', {
          expectedId: annotationIdParam,
          availableIds: projection.annotations.map((a: any) => a.id)
        });
        throw new HTTPException(404, { message: `Annotation ${annotationIdParam} not found in resource ${resourceIdParam}` });
      }
      logger.info('Found matching annotation', { annotationId: reference.id });

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
          userId: userId(userToDid(user)),
          userName: user.name || user.email,
          userEmail: user.email,
          userDomain: user.domain,
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          referenceId: makeAnnotationId(annotationIdParam),
          sourceResourceId: resourceId(resourceIdParam),
          sourceResourceName: (await ResourceContext.getResourceMetadata(resourceId(resourceIdParam), kb))?.name || 'Unknown',
          annotation: reference,
          title: body.title,
          prompt: body.prompt,
          language: body.language,
          entityTypes: getEntityTypes(reference).map(et => entityType(et)),
          context: body.context,
          temperature: body.temperature,
          maxTokens: body.maxTokens,
          storageUri: body.storageUri,
        }
      };

      await jobQueue.createJob(job);
      logger.info('Created generation job', {
        jobId: job.metadata.id,
        language: job.params.language
      });

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
          logger.info('Subscribing to EventBus for resource');

          // Subscribe to yield:progress
          subscriptions.push(
            resourceBus.get('yield:progress').subscribe(async (_event) => {
              if (isStreamClosed) return;
              logger.info('Generation started');
              try {
                await writeTypedSSE(stream, {
                  data: {
                    status: 'started',
                    referenceId: reference.id,
                    resourceName,
                    percentage: 0,
                    message: 'Starting...'
                  },
                  event: 'yield:progress',
                  id: String(Date.now())
                });
              } catch (error) {
                logger.warn('Client disconnected during start');
                cleanup();
              }
            })
          );

          // Subscribe to yield:progress
          subscriptions.push(
            resourceBus.get('yield:progress').subscribe(async (progress) => {
              if (isStreamClosed) return;
              logger.info('Generation progress', { progress });
              try {
                await writeTypedSSE(stream, {
                  data: {
                    status: progress.status,
                    referenceId: reference.id,
                    resourceName,
                    percentage: progress.percentage || 0,
                    message: progress.message || `${progress.status}...`
                  },
                  event: 'yield:progress',
                  id: String(Date.now())
                });
              } catch (error) {
                logger.warn('Client disconnected during progress');
                cleanup();
              }
            })
          );

          // Subscribe to job:completed
          subscriptions.push(
            resourceBus.get('job:completed').subscribe(async (event) => {
              if (isStreamClosed) return;
              logger.info('Generation completed');
              try {
                await writeTypedSSE(stream, {
                  data: {
                    status: 'complete',
                    referenceId: reference.id,
                    resourceName,
                    resourceId: event.payload.resultResourceId,
                    sourceResourceId: resourceIdParam,
                    percentage: 100,
                    message: 'Draft resource created! Ready for review.'
                  },
                  event: 'yield:finished',
                  id: String(Date.now())
                });
              } catch (error) {
                logger.warn('Client disconnected after completion');
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
            logger.info('Client disconnected from generation stream, job will continue', { jobId: job.metadata.id });
            cleanup();
          });

        } catch (error) {
          // Send error event
          try {
            await writeTypedSSE(stream, {
              data: {
                status: 'error',
                referenceId: reference.id,
                percentage: 0,
                message: error instanceof Error ? error.message : 'Generation failed'
              },
              event: 'yield:failed',
              id: String(Date.now())
            });
          } catch (sseError) {
            // Client already disconnected
            logger.warn('Could not send error to client (disconnected), job status is preserved', { jobId: job.metadata.id });
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
