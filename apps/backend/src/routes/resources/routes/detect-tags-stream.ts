/**
 * Detect Tags Stream Route - Event-Driven Version
 *
 * Event Store subscription architecture:
 * - No polling loops
 * - Subscribes to job.* events from Event Store
 * - <50ms latency for progress updates
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
import { createEventStore } from '../../../services/event-store-service';
import type { JobQueue } from '@semiont/jobs';
import type { TagDetectionJob } from '@semiont/jobs';
import { nanoid } from 'nanoid';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { jobId, resourceUri } from '@semiont/api-client';
import { userId, resourceId, type ResourceId } from '@semiont/core';
import { getTagSchema } from '@semiont/ontology';

type DetectTagsStreamRequest = components['schemas']['DetectTagsStreamRequest'];

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

export function registerDetectTagsStream(router: ResourcesRouterType, jobQueue: JobQueue) {
  /**
   * POST /resources/:id/detect-tags-stream
   *
   * Stream real-time tag detection progress via Server-Sent Events
   * Requires authentication
   * Validates request body against DetectTagsStreamRequest schema
   * Returns SSE stream with progress updates
   *
   * Event-Driven Architecture:
   * - Creates tag detection job
   * - Subscribes to Event Store for job.* events
   * - Forwards events to client as SSE
   * - <50ms latency (no polling)
   */
  router.post('/resources/:id/detect-tags-stream',
    validateRequestBody('DetectTagsStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as DetectTagsStreamRequest;
      const { schemaId, categories } = body;
      const config = c.get('config');

      console.log(`[DetectTags] Starting tag detection for resource ${id} with schema ${schemaId}, categories: ${categories.join(', ')}`);

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

      // Create Event Store instance for event subscriptions
      const eventStore = await createEventStore(config);

      // Construct full resource URI for event subscriptions
      const rUri = resourceUri(`${config.services.backend!.publicURL}/resources/${id}`);

      // Create a tag detection job
      const job: TagDetectionJob = {
        id: jobId(`job-${nanoid()}`),
        type: 'tag-detection',
        status: 'pending',
        userId: userId(user.id),
        resourceId: resourceId(id),
        schemaId,
        categories,
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 1
      };

      await jobQueue.createJob(job);
      console.log(`[DetectTags] Created job ${job.id} for resource ${id}`);

      // Stream job progress to the client using Event Store subscriptions
      return streamSSE(c, async (stream) => {
        // Track if stream is closed to prevent double cleanup
        let isStreamClosed = false;
        let subscription: ReturnType<typeof eventStore.bus.subscriptions.subscribe> | null = null;
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

          if (subscription) {
            subscription.unsubscribe();
          }

          // Close the stream by resolving the promise
          if (closeStreamCallback) {
            closeStreamCallback();
          }
        };

        try {
          // Subscribe to Event Store for job events on this resource
          // Workers emit job.started, job.progress, job.completed, job.failed events
          console.log(`[DetectTags] Subscribing to events for resource ${rUri}, filtering for job ${job.id}`);
          subscription = eventStore.bus.subscriptions.subscribe(rUri, async (storedEvent) => {
            if (isStreamClosed) {
              console.log(`[DetectTags] Stream already closed, ignoring event ${storedEvent.event.type}`);
              return;
            }

            const event = storedEvent.event;

            // Filter to this job's events only
            if (event.type === 'job.started' && event.payload.jobId === job.id) {
              console.log(`[DetectTags] Job ${job.id} started`);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'started',
                    resourceId: resourceId(id),
                    totalCategories: categories.length,
                    message: 'Starting detection...'
                  } as TagDetectionProgress),
                  event: 'tag-detection-started',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (error) {
                console.warn(`[DetectTags] Client disconnected, job ${job.id} will continue`);
                cleanup();
              }
            } else if (event.type === 'job.progress' && event.payload.jobId === job.id) {
              console.log(`[DetectTags] Job ${job.id} progress:`, event.payload);
              try {
                // Extract progress info from the job's progress field
                const jobProgress = event.payload.progress;
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: jobProgress?.stage || 'analyzing',
                    resourceId: resourceId(id),
                    stage: jobProgress?.stage,
                    percentage: jobProgress?.percentage,
                    currentCategory: jobProgress?.currentCategory,
                    processedCategories: jobProgress?.processedCategories,
                    totalCategories: jobProgress?.totalCategories,
                    message: jobProgress?.message || 'Processing...'
                  } as TagDetectionProgress),
                  event: 'tag-detection-progress',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (error) {
                console.warn(`[DetectTags] Client disconnected, job ${job.id} will continue`);
                cleanup();
              }
            } else if (event.type === 'job.completed' && event.payload.jobId === job.id) {
              console.log(`[DetectTags] Job ${job.id} completed`);
              try {
                const result = event.payload.result;
                await stream.writeSSE({
                  data: JSON.stringify({
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
                  event: 'tag-detection-complete',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (error) {
                console.warn(`[DetectTags] Client disconnected after job ${job.id} completed`);
              }
              cleanup();
            } else if (event.type === 'job.failed' && event.payload.jobId === job.id) {
              console.log(`[DetectTags] Job ${job.id} failed:`, event.payload.error);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'error',
                    resourceId: resourceId(id),
                    message: event.payload.error || 'Tag detection failed'
                  } as TagDetectionProgress),
                  event: 'tag-detection-error',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (error) {
                console.warn(`[DetectTags] Client disconnected after job ${job.id} failed`);
              }
              cleanup();
            }
          });

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
            console.log(`[DetectTags] Client disconnected from detection stream for resource ${id}, job ${job.id} will continue`);
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
              event: 'tag-detection-error',
              id: String(Date.now())
            });
          } catch (sseError) {
            // Client already disconnected
            console.warn(`[DetectTags] Could not send error to client (disconnected), job ${job.id} status is preserved`);
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
