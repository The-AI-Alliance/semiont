/**
 * Detect Tags Stream Route - EventBus Version
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
import type { JobQueue, PendingJob, TagDetectionParams } from '@semiont/jobs';
import { nanoid } from 'nanoid';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { jobId } from '@semiont/core';
import { userId, resourceId, type ResourceId } from '@semiont/core';
import { writeTypedSSE } from '../../../lib/sse-helpers';
import { getTagSchema } from '@semiont/ontology';
import { getLogger } from '../../../logger';

type AnnotateTagsStreamRequest = components['schemas']['AnnotateTagsStreamRequest'];

interface TagDetectionProgress {
  status: 'started' | 'analyzing' | 'creating' | 'complete' | 'error';
  resourceId: ResourceId;
  stage?: 'analyzing' | 'creating';
  percentage?: number;
  currentCategory?: string;
  processedCategories?: number;
  totalCategories?: number;
  message?: string;
  foundCount?: number;
  createdCount?: number;
  byCategory?: Record<string, number>;
}

export function registerAnnotateTagsStream(router: ResourcesRouterType, jobQueue: JobQueue) {
  /**
   * POST /resources/:id/detect-tags-stream
   *
   * Stream real-time tag detection progress via Server-Sent Events
   * Requires authentication
   * Validates request body against AnnotateTagsStreamRequest schema
   * Returns SSE stream with progress updates
   *
   * Event-Driven Architecture:
   * - Creates tag detection job
   * - Subscribes to Event Store for job.* events
   * - Forwards events to client as SSE
   * - <50ms latency (no polling)
   */
  router.post('/resources/:id/annotate-tags-stream',
    validateRequestBody('AnnotateTagsStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as AnnotateTagsStreamRequest;
      const { schemaId, categories } = body;
      const config = c.get('config');

      const logger = getLogger().child({
        component: 'annotate-tags-stream',
        resourceId: id
      });

      logger.info('Starting tag detection', { schemaId, categories });

      // User will be available from auth middleware since this is a POST request
      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      // Validate schema exists
      const schema = getTagSchema(schemaId);
      if (!schema) {
        throw new HTTPException(400, { message: `Invalid tag schema: ${schemaId}` });
      }

      // Validate categories
      for (const category of categories) {
        if (!schema.tags.some(t => t.name === category)) {
          throw new HTTPException(400, { message: `Invalid category "${category}" for schema ${schemaId}` });
        }
      }

      if (categories.length === 0) {
        throw new HTTPException(400, { message: 'At least one category must be selected' });
      }

      // Validate resource exists using view storage
      const resource = await ResourceContext.getResourceMetadata(resourceId(id), config);
      if (!resource) {
        throw new HTTPException(404, { message: 'Resource not found in view storage projections - resource may need to be recreated' });
      }

      // Get EventBus for real-time progress subscriptions
      const { eventBus } = c.get('makeMeaning');

      // Create a tag detection job
      const job: PendingJob<TagDetectionParams> = {
        status: 'pending',
        metadata: {
          id: jobId(`job-${nanoid()}`),
          type: 'tag-annotation',
          userId: userId(user.id),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 1
        },
        params: {
          resourceId: resourceId(id),
          schemaId,
          categories
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

          // Subscribe to mark:progress
          subscriptions.push(
            resourceBus.get('mark:progress').subscribe(async (_event) => {
              if (isStreamClosed) return;
              logger.info('Detection started');
              try {
                await writeTypedSSE(stream, {
                  data: JSON.stringify({
                    status: 'started',
                    resourceId: resourceId(id),
                    totalCategories: categories.length,
                    message: 'Starting detection...'
                  } as TagDetectionProgress),
                  event: 'mark:progress',
                  id: String(Date.now())
                });
              } catch (error) {
                logger.warn('Client disconnected during start');
                cleanup();
              }
            })
          );

          // Subscribe to mark:progress
          subscriptions.push(
            resourceBus.get('mark:progress').subscribe(async (progress) => {
              if (isStreamClosed) return;
              logger.info('Detection progress', { progress });
              try {
                await writeTypedSSE(stream, {
                  data: JSON.stringify({
                    status: progress.status || 'analyzing',
                    resourceId: resourceId(id),
                    stage: progress.status === 'analyzing' || progress.status === 'creating' ? progress.status : undefined,
                    percentage: progress.percentage,
                    currentCategory: progress.currentCategory,
                    processedCategories: progress.processedCategories,
                    totalCategories: progress.totalCategories,
                    message: progress.message || 'Processing...'
                  } as TagDetectionProgress),
                  event: 'mark:progress',
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
      if (event.payload.jobType !== 'tag-annotation') return;
              if (isStreamClosed) return;
              logger.info('Detection completed');
              try {
                const result = event.payload.result;
                await writeTypedSSE(stream, {
                  data: JSON.stringify({
                    motivation: 'tagging',
                    status: 'complete',
                    resourceId: resourceId(id),
                    percentage: 100,
                    foundCount: result?.tagsFound,
                    createdCount: result?.tagsCreated,
                    byCategory: result?.byCategory,
                    message: result?.tagsCreated !== undefined
                      ? `Complete! Created ${result.tagsCreated} tags`
                      : 'Tag detection complete!'
                  } as TagDetectionProgress),
                  event: 'mark:assist-finished',
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
            resourceBus.get('job:failed').subscribe(async (event) => {
      if (event.payload.jobType !== 'tag-annotation') return;
              if (isStreamClosed) return;
              logger.info('Detection failed', { error: event.payload.error });
              try {
                await writeTypedSSE(stream, {
                  data: JSON.stringify({
                    status: 'error',
                    resourceId: resourceId(id),
                    message: event.payload.error || 'Tag detection failed'
                  } as TagDetectionProgress),
                  event: 'mark:assist-failed',
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
                message: error instanceof Error ? error.message : 'Tag detection failed'
              } as TagDetectionProgress),
              event: 'mark:assist-failed',
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
