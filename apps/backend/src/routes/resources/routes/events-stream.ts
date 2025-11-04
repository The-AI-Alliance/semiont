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
import { resourceUri } from '@semiont/core';
import { createEventStore, createEventQuery } from '../../../services/event-store-service';
import { resourceId } from '@semiont/core';

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
   * GET /api/resources/:id/events/stream
   *
   * Open a Server-Sent Events stream to receive real-time resource events
   * Requires authentication
   * Returns text/event-stream
   */
  router.get('/api/resources/:id/events/stream', async (c) => {
    const { id } = c.req.param();
    const config = c.get('config');

    // Construct full resource URI for event subscriptions (consistent with W3C Web Annotation spec)
    const rUri = resourceUri(`${config.services.backend!.publicURL}/resources/${id}`);

    console.log(`[EventStream] Client connecting to resource events stream for ${id}`);
    console.log(`[EventStream] Subscribing to events for resource URI: ${rUri}`);

    // Verify resource exists in event store (Layer 2 - source of truth)
    const eventStore = await createEventStore( config);
    const query = createEventQuery(eventStore);
    const events = await query.getResourceEvents(resourceId(id));
    if (events.length === 0) {
      console.log(`[EventStream] Resource ${id} not found - no events exist`);
      throw new HTTPException(404, { message: 'Resource not found - no events exist for this resource' });
    }

    console.log(`[EventStream] Resource ${id} exists with ${events.length} events`);

    return streamSSE(c, async (stream) => {

      // Send initial connection message
      console.log(`[EventStream] Sending connection message to client for ${id}`);
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'connected',
          resourceId: id,
          timestamp: new Date().toISOString(),
          message: 'Event stream connected',
        }),
        event: 'stream-connected',
        id: String(Date.now()),
      });

      // Track if stream is closed to prevent double cleanup
      let isStreamClosed = false;
      let subscription: ReturnType<typeof eventStore.subscriptions.subscribe> | null = null;
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
      console.log(`[EventStream:${streamId}] Subscribing to events for resource URI ${rUri}`);
      subscription = eventStore.subscriptions.subscribe(rUri, async (storedEvent) => {
        if (isStreamClosed) {
          console.log(`[EventStream:${streamId}] Stream already closed for ${rUri}, ignoring event ${storedEvent.event.type}`);
          return;
        }

        console.log(`[EventStream:${streamId}] Received event ${storedEvent.event.type} for resource ${rUri}, attempting to write to SSE stream`);

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

          console.log(`[EventStream:${streamId}] Event data prepared, calling writeSSE...`);
          await stream.writeSSE({
            data: JSON.stringify(eventData),
            event: storedEvent.event.type,
            id: storedEvent.metadata.sequenceNumber.toString(),
          });
          console.log(`[EventStream:${streamId}] Successfully wrote event ${storedEvent.event.type} to SSE stream for ${resourceUri}`);
        } catch (error) {
          console.error(`[EventStream:${streamId}] Error writing event ${storedEvent.event.type} to SSE stream for ${resourceUri}:`, error);
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
        console.log(`[EventStream] Client disconnected from resource events stream for ${id}`);
        cleanup();
      });

      // Return promise that resolves when stream should close
      // This keeps the SSE connection open until cleanup() is called
      return streamPromise;
    });
  });
}
