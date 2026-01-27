/**
 * Detect Annotations Stream Route - Event-Driven Version
 *
 * Migrated from polling to Event Store subscriptions:
 * - No polling loops (previously 500ms intervals)
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
import type { JobQueue, DetectionJob } from '@semiont/jobs';
import { nanoid } from 'nanoid';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { jobId, entityType, resourceUri } from '@semiont/api-client';
import { userId, resourceId, type ResourceId } from '@semiont/core';

type DetectAnnotationsStreamRequest = components['schemas']['DetectAnnotationsStreamRequest'];

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
   * Validates request body against DetectAnnotationsStreamRequest schema
   * Returns SSE stream with progress updates
   *
   * Event-Driven Architecture:
   * - Creates detection job
   * - Subscribes to Event Store for job.* events
   * - Forwards events to client as SSE
   * - <50ms latency (no polling)
   */
  router.post('/resources/:id/detect-annotations-stream',
    validateRequestBody('DetectAnnotationsStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as DetectAnnotationsStreamRequest;
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

      // Create Event Store instance for event subscriptions
      const eventStore = await createEventStore(config);

      // Construct full resource URI for event subscriptions
      const rUri = resourceUri(`${config.services.backend!.publicURL}/resources/${id}`);

      // Create a detection job (this decouples event emission from HTTP client)
      const job: DetectionJob = {
        id: jobId(`job-${nanoid()}`),
        type: 'detection',
        status: 'pending',
        userId: userId(user.id),
        resourceId: resourceId(id),
        entityTypes: entityTypes.map(et => entityType(et)),
        includeDescriptiveReferences,
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 1
      };

      await jobQueue.createJob(job);
      console.log(`[DetectAnnotations] Created job ${job.id} for resource ${id}`);

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
          console.log(`[DetectAnnotations] Subscribing to events for resource ${rUri}, filtering for job ${job.id}`);
          subscription = eventStore.bus.subscriptions.subscribe(rUri, async (storedEvent) => {
            if (isStreamClosed) {
              console.log(`[DetectAnnotations] Stream already closed, ignoring event ${storedEvent.event.type}`);
              return;
            }

            const event = storedEvent.event;

            // Filter to this job's events only
            if (event.type === 'job.started' && event.payload.jobId === job.id) {
              console.log(`[DetectAnnotations] Job ${job.id} started`);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'started',
                    resourceId: resourceId(id),
                    totalEntityTypes: event.payload.totalSteps || entityTypes.length,
                    processedEntityTypes: 0,
                    message: 'Starting entity detection...'
                  } as DetectionProgress),
                  event: 'detection-started',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (error) {
                console.warn(`[DetectAnnotations] Client disconnected, job ${job.id} will continue`);
                cleanup();
              }
            } else if (event.type === 'job.progress' && event.payload.jobId === job.id) {
              console.log(`[DetectAnnotations] Job ${job.id} progress:`, event.payload);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'scanning',
                    resourceId: resourceId(id),
                    currentEntityType: event.payload.currentStep,
                    totalEntityTypes: event.payload.totalSteps,
                    processedEntityTypes: event.payload.processedSteps || 0,
                    foundCount: event.payload.foundCount,
                    message: event.payload.currentStep
                      ? `Scanning for ${event.payload.currentStep}...`
                      : 'Processing...'
                  } as DetectionProgress),
                  event: 'detection-progress',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (error) {
                console.warn(`[DetectAnnotations] Client disconnected, job ${job.id} will continue`);
                cleanup();
              }
            } else if (event.type === 'job.completed' && event.payload.jobId === job.id) {
              console.log(`[DetectAnnotations] Job ${job.id} completed`);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'complete',
                    resourceId: resourceId(id),
                    totalEntityTypes: entityTypes.length,
                    processedEntityTypes: entityTypes.length,
                    foundCount: event.payload.foundCount,
                    message: event.payload.foundCount !== undefined
                      ? `Detection complete! Found ${event.payload.foundCount} entities`
                      : 'Detection complete!'
                  } as DetectionProgress),
                  event: 'detection-complete',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (error) {
                console.warn(`[DetectAnnotations] Client disconnected after job ${job.id} completed`);
              }
              cleanup();
            } else if (event.type === 'job.failed' && event.payload.jobId === job.id) {
              console.log(`[DetectAnnotations] Job ${job.id} failed:`, event.payload.error);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'error',
                    resourceId: resourceId(id),
                    totalEntityTypes: entityTypes.length,
                    processedEntityTypes: 0,
                    message: event.payload.error || 'Detection failed'
                  } as DetectionProgress),
                  event: 'detection-error',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (error) {
                console.warn(`[DetectAnnotations] Client disconnected after job ${job.id} failed`);
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
            console.log(`[DetectAnnotations] Client disconnected from detection stream for resource ${id}, job ${job.id} will continue`);
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
              event: 'detection-error',
              id: String(Date.now())
            });
          } catch (sseError) {
            // Client already disconnected
            console.warn(`[DetectAnnotations] Could not send error to client (disconnected), job ${job.id} status is preserved`);
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
