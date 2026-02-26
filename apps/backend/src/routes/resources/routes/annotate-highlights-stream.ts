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
import { getLogger } from '../../../logger';

type AnnotateHighlightsStreamRequest = components['schemas']['AnnotateHighlightsStreamRequest'];

interface HighlightDetectionProgress {
  status: 'started' | 'analyzing' | 'creating' | 'complete' | 'error';
  resourceId: ResourceId;
  stage?: 'analyzing' | 'creating';
  percentage?: number;
  message?: string;
  foundCount?: number;
  createdCount?: number;
}

export function registerAnnotateHighlightsStream(router: ResourcesRouterType, jobQueue: JobQueue) {
  /**
   * POST /resources/:id/detect-highlights-stream
   *
   * Stream real-time highlight detection progress via Server-Sent Events
   * Requires authentication
   * Validates request body against AnnotateHighlightsStreamRequest schema
   * Returns SSE stream with progress updates
   *
   * Event-Driven Architecture:
   * - Creates highlight detection job
   * - Subscribes to Event Store for job.* events
   * - Forwards events to client as SSE
   * - <50ms latency (no polling)
   */
  router.post('/resources/:id/annotate-highlights-stream',
    validateRequestBody('AnnotateHighlightsStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as AnnotateHighlightsStreamRequest;
      const { instructions, density } = body;
      const config = c.get('config');

      // Validate density if provided
      if (density !== undefined && (typeof density !== 'number' || density < 1 || density > 15)) {
        throw new HTTPException(400, { message: 'Invalid density. Must be a number between 1 and 15.' });
      }

      const logger = getLogger().child({
        component: 'annotate-highlights-stream',
        resourceId: id
      });

      logger.info('Starting highlight detection', { instructions: !!instructions, density });

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
          type: 'highlight-annotation',
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
      logger.info('Created detection job', { jobId: job.metadata.id });

      // Disable proxy buffering for real-time SSE streaming
      c.header('X-Accel-Buffering', 'no');
      c.header('Cache-Control', 'no-cache, no-transform');

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
          logger.info('Subscribing to EventBus for resource');

          // Subscribe to annotate:progress
          subscriptions.push(
            resourceBus.get('annotate:progress').subscribe(async (_event) => {
              if (isStreamClosed) return;
              logger.info('Detection started');
              try {
                await writeTypedSSE(stream, {
                  data: JSON.stringify({
                    status: 'started',
                    resourceId: resourceId(id),
                    message: 'Starting detection...'
                  } as HighlightDetectionProgress),
                  event: 'annotate:progress',
                  id: String(Date.now())
                });
              } catch (error) {
                logger.warn('Client disconnected during start');
                cleanup();
              }
            })
          );

          // Subscribe to annotate:progress
          subscriptions.push(
            resourceBus.get('annotate:progress').subscribe(async (progress) => {
              if (isStreamClosed) return;
              logger.info('Detection progress', { progress });
              try {
                await writeTypedSSE(stream, {
                  data: JSON.stringify({
                    status: progress.status || 'analyzing',
                    resourceId: resourceId(id),
                    stage: progress.status === 'analyzing' || progress.status === 'creating' ? progress.status : undefined,
                    percentage: progress.percentage,
                    message: progress.message || 'Processing...'
                  } as HighlightDetectionProgress),
                  event: 'annotate:progress',
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
            resourceBus.get('job.completed').subscribe(async (event) => {
      if (event.payload.jobType !== 'highlight-annotation') return;
              if (isStreamClosed) return;
              logger.info('Detection completed');
              try {
                const result = event.payload.result;
                await writeTypedSSE(stream, {
                  data: JSON.stringify({
                    motivation: 'highlighting',
                    status: 'complete',
                    resourceId: resourceId(id),
                    percentage: 100,
                    foundCount: result?.highlightsFound,
                    createdCount: result?.highlightsCreated,
                    message: result?.highlightsCreated !== undefined
                      ? `Complete! Created ${result.highlightsCreated} highlights`
                      : 'Highlight detection complete!'
                  } as HighlightDetectionProgress),
                  event: 'annotate:assist-finished',
                  id: String(Date.now())
                });
              } catch (error) {
                logger.warn('Client disconnected after completion');
              }
              cleanup();
            })
          );

          // Subscribe to job:failed
          subscriptions.push(
            resourceBus.get('job.failed').subscribe(async (event) => {
      if (event.payload.jobType !== 'highlight-annotation') return;
              if (isStreamClosed) return;
              logger.info('Detection failed', { error: event.payload.error });
              try {
                await writeTypedSSE(stream, {
                  data: JSON.stringify({
                    status: 'error',
                    resourceId: resourceId(id),
                    message: event.payload.error || 'Highlight detection failed'
                  } as HighlightDetectionProgress),
                  event: 'annotate:assist-failed',
                  id: String(Date.now())
                });
              } catch (error) {
                logger.warn('Client disconnected after failure');
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
            logger.info('Client disconnected from detection stream, job will continue', { jobId: job.metadata.id });
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
              event: 'annotate:assist-failed',
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
