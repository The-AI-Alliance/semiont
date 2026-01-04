/**
 * Detect Assessments Stream Route - Event-Driven Version
 *
 * Migrated from polling to Event Store subscriptions:
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
import { ResourceQueryService } from '../../../services/resource-queries';
import { createEventStore } from '../../../services/event-store-service';
import { getJobQueue } from '@semiont/jobs';
import type { AssessmentDetectionJob } from '@semiont/jobs';
import { nanoid } from 'nanoid';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { jobId, resourceUri } from '@semiont/api-client';
import { userId, resourceId, type ResourceId } from '@semiont/core';

type DetectAssessmentsStreamRequest = components['schemas']['DetectAssessmentsStreamRequest'];

interface AssessmentDetectionProgress {
  status: 'started' | 'analyzing' | 'creating' | 'complete' | 'error';
  resourceId: ResourceId;
  stage?: 'analyzing' | 'creating';
  percentage?: number;
  message?: string;
  foundCount?: number;
  createdCount?: number;
}

export function registerDetectAssessmentsStream(router: ResourcesRouterType) {
  /**
   * POST /resources/:id/detect-assessments-stream
   *
   * Stream real-time assessment detection progress via Server-Sent Events
   * Requires authentication
   * Validates request body against DetectAssessmentsStreamRequest schema
   * Returns SSE stream with progress updates
   *
   * Event-Driven Architecture:
   * - Creates assessment detection job
   * - Subscribes to Event Store for job.* events
   * - Forwards events to client as SSE
   * - <50ms latency (no polling)
   */
  router.post('/resources/:id/detect-assessments-stream',
    validateRequestBody('DetectAssessmentsStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as DetectAssessmentsStreamRequest;
      const { instructions, tone, density } = body;
      const config = c.get('config');

      // Validate density if provided
      if (density !== undefined && (typeof density !== 'number' || density < 1 || density > 10)) {
        throw new HTTPException(400, { message: 'Invalid density. Must be a number between 1 and 10.' });
      }

      console.log(`[DetectAssessments] Starting assessment detection for resource ${id}${instructions ? ' with instructions' : ''}${tone ? ` (tone: ${tone})` : ''}${density ? ` (density: ${density})` : ''}`);

      // User will be available from auth middleware since this is a POST request
      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      // Validate resource exists using view storage
      const resource = await ResourceQueryService.getResourceMetadata(resourceId(id), config);
      if (!resource) {
        throw new HTTPException(404, { message: 'Resource not found in view storage projections - resource may need to be recreated' });
      }

      // Create Event Store instance for event subscriptions
      const eventStore = await createEventStore(config);

      // Construct full resource URI for event subscriptions
      const rUri = resourceUri(`${config.services.backend!.publicURL}/resources/${id}`);

      // Create an assessment detection job
      const jobQueue = getJobQueue();
      const job: AssessmentDetectionJob = {
        id: jobId(`job-${nanoid()}`),
        type: 'assessment-detection',
        status: 'pending',
        userId: userId(user.id),
        resourceId: resourceId(id),
        instructions,
        tone,
        density,
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 1
      };

      await jobQueue.createJob(job);
      console.log(`[DetectAssessments] Created job ${job.id} for resource ${id}`);

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
          console.log(`[DetectAssessments] Subscribing to events for resource ${rUri}, filtering for job ${job.id}`);
          subscription = eventStore.bus.subscriptions.subscribe(rUri, async (storedEvent) => {
            if (isStreamClosed) {
              console.log(`[DetectAssessments] Stream already closed, ignoring event ${storedEvent.event.type}`);
              return;
            }

            const event = storedEvent.event;

            // Filter to this job's events only
            if (event.type === 'job.started' && event.payload.jobId === job.id) {
              console.log(`[DetectAssessments] Job ${job.id} started`);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'started',
                    resourceId: resourceId(id),
                    message: 'Starting detection...'
                  } as AssessmentDetectionProgress),
                  event: 'assessment-detection-started',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (error) {
                console.warn(`[DetectAssessments] Client disconnected, job ${job.id} will continue`);
                cleanup();
              }
            } else if (event.type === 'job.progress' && event.payload.jobId === job.id) {
              console.log(`[DetectAssessments] Job ${job.id} progress:`, event.payload);
              try {
                // Extract progress info from the job's progress field
                const jobProgress = event.payload.progress;
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: jobProgress?.stage || 'analyzing',
                    resourceId: resourceId(id),
                    stage: jobProgress?.stage,
                    percentage: jobProgress?.percentage,
                    message: jobProgress?.message || 'Processing...'
                  } as AssessmentDetectionProgress),
                  event: 'assessment-detection-progress',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (error) {
                console.warn(`[DetectAssessments] Client disconnected, job ${job.id} will continue`);
                cleanup();
              }
            } else if (event.type === 'job.completed' && event.payload.jobId === job.id) {
              console.log(`[DetectAssessments] Job ${job.id} completed`);
              try {
                const result = event.payload.result;
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'complete',
                    resourceId: resourceId(id),
                    percentage: 100,
                    foundCount: result?.assessmentsFound,
                    createdCount: result?.assessmentsCreated,
                    message: result?.assessmentsCreated !== undefined
                      ? `Complete! Created ${result.assessmentsCreated} assessments`
                      : 'Assessment detection complete!'
                  } as AssessmentDetectionProgress),
                  event: 'assessment-detection-complete',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (error) {
                console.warn(`[DetectAssessments] Client disconnected after job ${job.id} completed`);
              }
              cleanup();
            } else if (event.type === 'job.failed' && event.payload.jobId === job.id) {
              console.log(`[DetectAssessments] Job ${job.id} failed:`, event.payload.error);
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'error',
                    resourceId: resourceId(id),
                    message: event.payload.error || 'Assessment detection failed'
                  } as AssessmentDetectionProgress),
                  event: 'assessment-detection-error',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (error) {
                console.warn(`[DetectAssessments] Client disconnected after job ${job.id} failed`);
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
            console.log(`[DetectAssessments] Client disconnected from detection stream for resource ${id}, job ${job.id} will continue`);
            cleanup();
          });

        } catch (error) {
          // Send error event
          try {
            await stream.writeSSE({
              data: JSON.stringify({
                status: 'error',
                resourceId: resourceId(id),
                message: error instanceof Error ? error.message : 'Assessment detection failed'
              } as AssessmentDetectionProgress),
              event: 'assessment-detection-error',
              id: String(Date.now())
            });
          } catch (sseError) {
            // Client already disconnected
            console.warn(`[DetectAssessments] Could not send error to client (disconnected), job ${job.id} status is preserved`);
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
