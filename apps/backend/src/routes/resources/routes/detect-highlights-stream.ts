/**
 * Detect Highlights Stream Route - EventBus Version
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
import type { JobQueue, PendingJob, HighlightDetectionParams } from '@semiont/jobs';
import { nanoid } from 'nanoid';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { jobId } from '@semiont/core';
import { userId, resourceId, type ResourceId } from '@semiont/core';
import { writeTypedSSE } from '../../../lib/sse-helpers';

type DetectHighlightsStreamRequest = components['schemas']['DetectHighlightsStreamRequest'];

interface HighlightDetectionProgress {
  status: 'started' | 'analyzing' | 'creating' | 'complete' | 'error';
  resourceId: ResourceId;
  stage?: 'analyzing' | 'creating';
  percentage?: number;
  message?: string;
  foundCount?: number;
  createdCount?: number;
}

export function registerDetectHighlightsStream(router: ResourcesRouterType, jobQueue: JobQueue) {
  /**
   * POST /resources/:id/detect-highlights-stream
   *
   * Stream real-time highlight detection progress via Server-Sent Events
   * Requires authentication
   * Validates request body against DetectHighlightsStreamRequest schema
   * Returns SSE stream with progress updates
   *
   * Event-Driven Architecture:
   * - Creates highlight detection job
   * - Subscribes to Event Store for job.* events
   * - Forwards events to client as SSE
   * - <50ms latency (no polling)
   */
  router.post('/resources/:id/detect-highlights-stream',
    validateRequestBody('DetectHighlightsStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as DetectHighlightsStreamRequest;
      const { instructions, density } = body;
      const config = c.get('config');

      // Validate density if provided
      if (density !== undefined && (typeof density !== 'number' || density < 1 || density > 15)) {
        throw new HTTPException(400, { message: 'Invalid density. Must be a number between 1 and 15.' });
      }

      console.log(`[DetectHighlights] Starting highlight detection for resource ${id}${instructions ? ' with instructions' : ''}${density ? ` (density: ${density})` : ''}`);

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

      // Create a highlight detection job
      const job: PendingJob<HighlightDetectionParams> = {
        status: 'pending',
        metadata: {
          id: jobId(`job-${nanoid()}`),
          type: 'highlight-detection',
          userId: userId(user.id),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 1
        },
        params: {
          resourceId: resourceId(id),
          instructions,
          density
        }
      };

      await jobQueue.createJob(job);
      console.log(`[DetectHighlights] Created job ${job.metadata.id} for resource ${id}`);

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
          console.log(`[DetectHighlights] Subscribing to EventBus for resource ${id}`);

          // Subscribe to detect:progress
          subscriptions.push(
            resourceBus.get('detect:progress').subscribe(async (_event) => {
              if (isStreamClosed) return;
              console.log(`[DetectHighlights] Detection started for resource ${id}`);
              try {
                await writeTypedSSE(stream, {
                  data: JSON.stringify({
                    status: 'started',
                    resourceId: resourceId(id),
                    message: 'Starting detection...'
                  } as HighlightDetectionProgress),
                  event: 'detect:progress',
                  id: String(Date.now())
                });
              } catch (error) {
                console.warn(`[DetectHighlights] Client disconnected during start`);
                cleanup();
              }
            })
          );

          // Subscribe to detect:progress
          subscriptions.push(
            resourceBus.get('detect:progress').subscribe(async (progress) => {
              if (isStreamClosed) return;
              console.log(`[DetectHighlights] Detection progress for resource ${id}:`, progress);
              try {
                await writeTypedSSE(stream, {
                  data: JSON.stringify({
                    status: progress.status || 'analyzing',
                    resourceId: resourceId(id),
                    stage: progress.status === 'analyzing' || progress.status === 'creating' ? progress.status : undefined,
                    percentage: progress.percentage,
                    message: progress.message || 'Processing...'
                  } as HighlightDetectionProgress),
                  event: 'detect:progress',
                  id: String(Date.now())
                });
              } catch (error) {
                console.warn(`[DetectHighlights] Client disconnected during progress`);
                cleanup();
              }
            })
          );

          // Subscribe to job.completed
          subscriptions.push(
            resourceBus.get('job.completed').subscribe(async (event) => {
      if (event.payload.jobType !== 'detection') return;
              if (isStreamClosed) return;
              console.log(`[DetectHighlights] Detection completed for resource ${id}`);
              try {
                const result = event.payload.result;
                await writeTypedSSE(stream, {
                  data: JSON.stringify({
                    status: 'complete',
                    resourceId: resourceId(id),
                    percentage: 100,
                    foundCount: result?.highlightsFound,
                    createdCount: result?.highlightsCreated,
                    message: result?.highlightsCreated !== undefined
                      ? `Complete! Created ${result.highlightsCreated} highlights`
                      : 'Highlight detection complete!'
                  } as HighlightDetectionProgress),
                  event: 'detect:finished',
                  id: String(Date.now())
                });
              } catch (error) {
                console.warn(`[DetectHighlights] Client disconnected after completion`);
              }
              cleanup();
            })
          );

          // Subscribe to job.failed
          subscriptions.push(
            resourceBus.get('job.failed').subscribe(async (event) => {
      if (event.payload.jobType !== 'detection') return;
              if (isStreamClosed) return;
              console.log(`[DetectHighlights] Detection failed for resource ${id}:`, event.payload.error);
              try {
                await writeTypedSSE(stream, {
                  data: JSON.stringify({
                    status: 'error',
                    resourceId: resourceId(id),
                    message: event.payload.error || 'Highlight detection failed'
                  } as HighlightDetectionProgress),
                  event: 'job.failed',
                  id: String(Date.now())
                });
              } catch (error) {
                console.warn(`[DetectHighlights] Client disconnected after failure`);
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
            console.log(`[DetectHighlights] Client disconnected from detection stream for resource ${id}, job ${job.metadata.id} will continue`);
            cleanup();
          });

        } catch (error) {
          // Send error event
          try {
            await stream.writeSSE({
              data: JSON.stringify({
                status: 'error',
                resourceId: resourceId(id),
                message: error instanceof Error ? error.message : 'Highlight detection failed'
              } as HighlightDetectionProgress),
              event: 'job.failed',
              id: String(Date.now())
            });
          } catch (sseError) {
            // Client already disconnected
            console.warn(`[DetectHighlights] Could not send error to client (disconnected), job ${job.metadata.id} status is preserved`);
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
