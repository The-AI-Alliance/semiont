import { EventQuery } from '@semiont/event-sourcing';

/**
 * Resource Events Stream Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No response validation (SSE streams validated on request only)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 *
 * SSE Strategy (per SSE-VALIDATION-CONSIDERATIONS.md):
 * - Validate request only (path params)
 * - No response validation (streaming data)
 * - Use TypeScript types for event data structures
 */

import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { resourceId } from '@semiont/core';
import { resourceUri } from '@semiont/core';
import { SSE_STREAM_CONNECTED } from '@semiont/api-client';
import { getLogger } from '../../../logger';

/**
 * Resource-scoped SSE event stream for real-time collaboration
 *
 * Opens a long-lived connection that broadcasts all events for a specific resource.
 * Clients receive events as they happen (highlights added, references created, etc.)
 *
 * Use case: Multiple users viewing the same resource see each other's changes in real-time
 */

export function registerGetEventStream(router: ResourcesRouterType) {
  /**
   * GET /resources/:id/events/stream
   *
   * Open a Server-Sent Events stream to receive real-time resource events
   * Requires authentication
   * Returns text/event-stream
   */
  router.get('/resources/:id/events/stream', async (c) => {
    const { id } = c.req.param();
    const config = c.get('config');

    const logger = getLogger().child({
      component: 'events-stream',
      resourceId: id
    });

    // Construct full resource URI for event subscriptions (consistent with W3C Web Annotation spec)
    const rUri = resourceUri(`${config.services.backend!.publicURL}/resources/${id}`);

    logger.info('Client connecting to resource events stream', { resourceUri: rUri });

    // Verify resource exists in event store (Event Store - source of truth)
    const { eventStore } = c.get('makeMeaning');
    const query = new EventQuery(eventStore.log.storage);
    const events = await query.getResourceEvents(resourceId(id));
    if (events.length === 0) {
      logger.warn('Resource not found - no events exist');
      throw new HTTPException(404, { message: 'Resource not found - no events exist for this resource' });
    }

    logger.info('Resource exists with events', { eventCount: events.length });

    return streamSSE(c, async (stream) => {

      // Send initial connection message
      logger.info('Sending connection message to client');
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'connected',
          resourceId: id,
          timestamp: new Date().toISOString(),
          message: 'Event stream connected',
        }),
        event: SSE_STREAM_CONNECTED,
        id: String(Date.now()),
      });

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

      // Subscribe to events for this resource using full URI
      const streamId = `${id.substring(0, 16)}...${Math.random().toString(36).substring(7)}`;
      logger.info('Subscribing to events for resource URI', { streamId, resourceUri: rUri });
      subscription = eventStore.bus.subscriptions.subscribe(rUri, async (storedEvent) => {
        if (isStreamClosed) {
          logger.info('Stream already closed, ignoring event', { streamId, eventType: storedEvent.event.type });
          return;
        }

        logger.info('Received event, attempting to write to SSE stream', {
          streamId,
          eventType: storedEvent.event.type
        });

        try {
          const eventData = {
            id: storedEvent.event.id,
            type: storedEvent.event.type,
            timestamp: storedEvent.event.timestamp,
            userId: storedEvent.event.userId,
            resourceId: storedEvent.event.resourceId,
            payload: storedEvent.event.payload,
            metadata: {
              sequenceNumber: storedEvent.metadata.sequenceNumber,
              prevEventHash: storedEvent.metadata.prevEventHash,
              checksum: storedEvent.metadata.checksum,
            },
          };

          logger.info('Event data prepared, calling writeSSE', { streamId });

          // DEBUG: Test JSON.stringify separately
          let jsonData: string;
          try {
            const startStringify = Date.now();
            jsonData = JSON.stringify(eventData);
            const stringifyTime = Date.now() - startStringify;
            logger.info('JSON.stringify completed', {
              streamId,
              time: stringifyTime,
              size: jsonData.length
            });
          } catch (stringifyError) {
            logger.error('JSON.stringify FAILED', { streamId, error: stringifyError });
            throw stringifyError;
          }

          // DEBUG: Log payload structure for annotation.body.updated
          if (storedEvent.event.type === 'annotation.body.updated') {
            logger.info('annotation.body.updated payload', {
              streamId,
              payload: storedEvent.event.payload
            });
          }

          const startWrite = Date.now();
          await stream.writeSSE({
            data: jsonData,
            event: storedEvent.event.type,
            id: storedEvent.metadata.sequenceNumber.toString(),
          });
          const writeTime = Date.now() - startWrite;
          logger.info('Successfully wrote event to SSE stream', {
            streamId,
            eventType: storedEvent.event.type,
            time: writeTime
          });
        } catch (error) {
          logger.error('Error writing event to SSE stream', {
            streamId,
            eventType: storedEvent.event.type,
            error
          });
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
        logger.info('Client disconnected from resource events stream');
        cleanup();
      });

      // Return promise that resolves when stream should close
      // This keeps the SSE connection open until cleanup() is called
      return streamPromise;
    });
  });
}
