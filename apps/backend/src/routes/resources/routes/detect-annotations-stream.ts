/**
 * Detect Annotations Stream Route - EventBus Version
 *
 * Uses @semiont/core EventBus for real-time progress:
 * - No polling loops
 * - Subscribes to detection:* events from EventBus
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
import { ResourceContext } from '@semiont/make-meaning';
import type { JobQueue, PendingJob, DetectionParams } from '@semiont/jobs';
import { nanoid } from 'nanoid';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { jobId, entityType } from '@semiont/core';
import { userId, resourceId, type ResourceId } from '@semiont/core';

type DetectReferencesStreamRequest = components['schemas']['DetectReferencesStreamRequest'];

interface DetectionProgress {
  status: 'started' | 'scanning' | 'complete' | 'error';
  resourceId: ResourceId;
  currentEntityType?: string;
  totalEntityTypes: number;
  processedEntityTypes: number;
  message?: string;
  foundCount?: number;
}

export function registerDetectAnnotationsStream(router: ResourcesRouterType, jobQueue: JobQueue) {
  /**
   * POST /resources/:id/detect-annotations-stream
   *
   * Stream real-time entity detection progress via Server-Sent Events
   * Requires authentication
   * Validates request body against DetectReferencesStreamRequest schema
   * Returns SSE stream with progress updates
   *
   * Event-Driven Architecture:
   * - Creates detection job
   * - Subscribes to Event Store for job.* events
   * - Forwards events to client as SSE
   * - <50ms latency (no polling)
   */
  router.post('/resources/:id/detect-annotations-stream',
    validateRequestBody('DetectReferencesStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as DetectReferencesStreamRequest;
      const { entityTypes, includeDescriptiveReferences } = body;
      const config = c.get('config');

      console.log(`[DetectAnnotations] Starting detection for resource ${id} with entity types:`, entityTypes, includeDescriptiveReferences ? '(including descriptive references)' : '');

      // User will be available from auth middleware since this is a POST request
      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      // Validate resource exists using view storage
      const resource = await ResourceContext.getResourceMetadata(resourceId(id), config);
      if (!resource) {
        throw new HTTPException(404, { message: 'Resource not found in view storage projections - resource may need to be recreated' });
      }

      // Get EventBus for real-time progress subscriptions
      const { eventBus } = c.get('makeMeaning');

      // Create a detection job (this decouples event emission from HTTP client)
      const job: PendingJob<DetectionParams> = {
        status: 'pending',
        metadata: {
          id: jobId(`job-${nanoid()}`),
          type: 'detection',
          userId: userId(user.id),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 1
        },
        params: {
          resourceId: resourceId(id),
          entityTypes: entityTypes.map(et => entityType(et)),
          includeDescriptiveReferences
        }
      };

      await jobQueue.createJob(job);
      console.log(`[DetectAnnotations] Created job ${job.metadata.id} for resource ${id}`);

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
          // Workers emit detection:started, detection:progress, detection:completed, detection:failed
          const resourceBus = eventBus.scope(id);
          console.log(`[DetectAnnotations] Subscribing to EventBus for resource ${id}`);

          // Subscribe to detection:started
          subscriptions.push(
            resourceBus.get('detection:started').subscribe(async (_event) => {
              if (isStreamClosed) return;
              console.log(`[DetectAnnotations] Detection started for resource ${id}`);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'started',
                    resourceId: resourceId(id),
                    totalEntityTypes: entityTypes.length,
                    processedEntityTypes: 0,
                    message: 'Starting entity detection...'
                  } as DetectionProgress),
                  event: 'reference-detection-started',
                  id: String(Date.now())
                });
              } catch (error) {
                console.warn(`[DetectAnnotations] Client disconnected during start`);
                cleanup();
              }
            })
          );

          // Subscribe to detection:progress
          subscriptions.push(
            resourceBus.get('detection:progress').subscribe(async (progress) => {
              if (isStreamClosed) return;
              console.log(`[DetectAnnotations] Detection progress for resource ${id}:`, progress);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'scanning',
                    resourceId: resourceId(id),
                    currentEntityType: progress.currentEntityType,
                    totalEntityTypes: entityTypes.length,
                    processedEntityTypes: progress.completedEntityTypes?.length || 0,
                    foundCount: progress.completedEntityTypes?.reduce((sum, et) => sum + et.foundCount, 0),
                    message: progress.message || (progress.currentEntityType
                      ? `Scanning for ${progress.currentEntityType}...`
                      : 'Processing...')
                  } as DetectionProgress),
                  event: 'reference-detection-progress',
                  id: String(Date.now())
                });
              } catch (error) {
                console.warn(`[DetectAnnotations] Client disconnected during progress`);
                cleanup();
              }
            })
          );

          // Subscribe to detection:completed
          subscriptions.push(
            resourceBus.get('detection:completed').subscribe(async (event) => {
              if (isStreamClosed) return;
              console.log(`[DetectAnnotations] Detection completed for resource ${id}`);
              try {
                const result = event.payload.result;
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'complete',
                    resourceId: resourceId(id),
                    totalEntityTypes: entityTypes.length,
                    processedEntityTypes: entityTypes.length,
                    foundCount: result?.totalFound,
                    message: result?.totalFound !== undefined
                      ? `Detection complete! Found ${result.totalFound} entities`
                      : 'Detection complete!'
                  } as DetectionProgress),
                  event: 'reference-detection-complete',
                  id: String(Date.now())
                });
              } catch (error) {
                console.warn(`[DetectAnnotations] Client disconnected after completion`);
              }
              cleanup();
            })
          );

          // Subscribe to detection:failed
          subscriptions.push(
            resourceBus.get('detection:failed').subscribe(async (event) => {
              if (isStreamClosed) return;
              console.log(`[DetectAnnotations] Detection failed for resource ${id}:`, event.payload.error);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'error',
                    resourceId: resourceId(id),
                    totalEntityTypes: entityTypes.length,
                    processedEntityTypes: 0,
                    message: event.payload.error || 'Detection failed'
                  } as DetectionProgress),
                  event: 'reference-detection-error',
                  id: String(Date.now())
                });
              } catch (error) {
                console.warn(`[DetectAnnotations] Client disconnected after failure`);
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
            console.log(`[DetectAnnotations] Client disconnected from detection stream for resource ${id}, job ${job.metadata.id} will continue`);
            cleanup();
          });

        } catch (error) {
          // Send error event
          try {
            await stream.writeSSE({
              data: JSON.stringify({
                status: 'error',
                resourceId: resourceId(id),
                totalEntityTypes: entityTypes.length,
                processedEntityTypes: 0,
                message: error instanceof Error ? error.message : 'Detection failed'
              } as DetectionProgress),
              event: 'reference-detection-error',
              id: String(Date.now())
            });
          } catch (sseError) {
            // Client already disconnected
            console.warn(`[DetectAnnotations] Could not send error to client (disconnected), job ${job.metadata.id} status is preserved`);
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
