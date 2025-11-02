/**
 * Detect Annotations Stream Route - Spec-First Version
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
import type { ResourcesRouterType } from '../shared';
import { ResourceQueryService } from '../../../services/resource-queries';
import { getJobQueue } from '../../../jobs/job-queue';
import type { DetectionJob } from '../../../jobs/types';
import { nanoid } from 'nanoid';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { createEventStore } from '../../../services/event-store-service';
import { getFilesystemConfig, getBackendConfig } from '../../../config/environment-loader';
import type { JobProgressEvent, JobCompletedEvent, JobFailedEvent } from '@semiont/core';
type DetectAnnotationsStreamRequest = components['schemas']['DetectAnnotationsStreamRequest'];
interface DetectionProgress {
  status: 'started' | 'scanning' | 'complete' | 'error';
  resourceId: string;
  currentEntityType?: string;
  totalEntityTypes: number;
  processedEntityTypes: number;
  message?: string;
  foundCount?: number;
}
export function registerDetectAnnotationsStream(router: ResourcesRouterType) {
  /**
   * POST /api/resources/:id/detect-annotations-stream
   *
   * Stream real-time entity detection progress via Server-Sent Events
   * Requires authentication
   * Validates request body against DetectAnnotationsStreamRequest schema
   * Returns SSE stream with progress updates
   */
  router.post('/api/resources/:id/detect-annotations-stream',
    validateRequestBody('DetectAnnotationsStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as DetectAnnotationsStreamRequest;
      const { entityTypes } = body;
      console.log(`[DetectAnnotations] Starting detection for resource ${id} with entity types:`, entityTypes);
      // User will be available from auth middleware since this is a POST request
      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }
      // Validate resource exists using Layer 3
      const resource = await ResourceQueryService.getResourceMetadata(id);
      if (!resource) {
        throw new HTTPException(404, { message: 'Resource not found in Layer 3 projections - resource may need to be recreated' });
      // Create a detection job (this decouples event emission from HTTP client)
      const jobQueue = getJobQueue();
      const job: DetectionJob = {
        id: `job-${nanoid()}`,
        type: 'detection',
        status: 'pending',
        userId: user.id,
        resourceId: id,
        entityTypes,
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      };
      await jobQueue.createJob(job);
      console.log(`[DetectAnnotations] Created job ${job.id} for resource ${id}`);
      // Stream the job's progress to the client
      return streamSSE(c, async (stream) => {
        try {
          // Send initial started event
          await stream.writeSSE({
            data: JSON.stringify({
              status: 'started',
              resourceId: id,
              totalEntityTypes: entityTypes.length,
              processedEntityTypes: 0,
              message: 'Starting entity detection...'
            } as DetectionProgress),
            event: 'detection-started',
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
          // Construct full resource URI for subscription (consistent with event publication)
          const backendConfig = getBackendConfig();
          const resourceUri = `${backendConfig.publicURL}/resources/${id}`;
          // Subscribe to all events for this resource using full URI
          const subscription = eventStore.subscriptions.subscribe(resourceUri, async (storedEvent) => {
            const event = storedEvent.event;
            // Filter events for this specific job
            if (event.type === 'job.progress' && event.payload.jobId === job.id) {
              const progressEvent = event as JobProgressEvent;
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    status: 'scanning',
                    resourceId: id,
                    currentEntityType: progressEvent.payload.currentStep,
                    totalEntityTypes: progressEvent.payload.totalSteps || entityTypes.length,
                    processedEntityTypes: progressEvent.payload.processedSteps || 0,
                    foundCount: progressEvent.payload.foundCount || 0,
                    message: progressEvent.payload.message || 'Processing...'
                  } as DetectionProgress),
                  event: 'detection-progress',
                  id: storedEvent.metadata.sequenceNumber.toString()
                });
              } catch (sseError) {
                console.warn(`[DetectAnnotations] Client disconnected, but job ${job.id} will continue processing`);
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
                  resourceId: id,
                  totalEntityTypes: entityTypes.length,
                  processedEntityTypes: entityTypes.length,
                  message: completedEvent.payload.message || 'Detection complete!'
                } as DetectionProgress),
                event: 'detection-complete',
                id: storedEvent.metadata.sequenceNumber.toString()
              });
              subscription.unsubscribe();
              if (jobDoneResolver) jobDoneResolver();
            // Handle job failure
            if (event.type === 'job.failed' && event.payload.jobId === job.id) {
              const failedEvent = event as JobFailedEvent;
                  status: 'error',
                  processedEntityTypes: 0,
                  message: failedEvent.payload.error || 'Detection failed'
                event: 'detection-error',
          // Keep the connection alive until the job is done
          await jobDonePromise;
        } catch (error) {
          // Send error event
          try {
            await stream.writeSSE({
              data: JSON.stringify({
                status: 'error',
                resourceId: id,
                totalEntityTypes: entityTypes.length,
                processedEntityTypes: 0,
                message: error instanceof Error ? error.message : 'Detection failed'
              } as DetectionProgress),
              event: 'detection-error',
              id: String(Date.now())
            });
          } catch (sseError) {
            // Client already disconnected
            console.warn(`[DetectAnnotations] Could not send error to client (disconnected), but job ${job.id} status is preserved`);
          }
        }
      });
    }
  );
