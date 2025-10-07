import { createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { DocumentsRouterType } from '../shared';
import { getEventStore } from '../../../events/event-store';

/**
 * Document-scoped SSE event stream for real-time collaboration
 *
 * Opens a long-lived connection that broadcasts all events for a specific document.
 * Clients receive events as they happen (highlights added, references created, etc.)
 *
 * Use case: Multiple users viewing the same document see each other's changes in real-time
 */

export const getEventStreamRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/events/stream',
  summary: 'Subscribe to Document Events (SSE)',
  description: 'Open a Server-Sent Events stream to receive real-time document events',
  tags: ['Documents', 'Events', 'Real-time'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'SSE stream opened successfully',
      content: {
        'text/event-stream': {
          schema: z.object({
            event: z.string(),
            data: z.string(),
            id: z.string().optional(),
          }),
        },
      },
    },
  },
});

export function registerGetEventStream(router: DocumentsRouterType) {
  router.openapi(getEventStreamRoute, async (c) => {
    const { id } = c.req.valid('param');

    console.log(`[EventStream] Client connecting to document events stream for ${id}`);

    // Verify document exists in event store (Layer 2 - source of truth)
    const eventStore = await getEventStore();
    const events = await eventStore.getDocumentEvents(id);
    if (events.length === 0) {
      console.log(`[EventStream] Document ${id} not found - no events exist`);
      throw new HTTPException(404, { message: 'Document not found - no events exist for this document' });
    }

    console.log(`[EventStream] Document ${id} exists with ${events.length} events`);

    return streamSSE(c, async (stream) => {

      // Send initial connection message
      console.log(`[EventStream] Sending connection message to client for ${id}`);
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'connected',
          documentId: id,
          timestamp: new Date().toISOString(),
          message: 'Event stream connected',
        }),
        event: 'stream-connected',
        id: String(Date.now()),
      });

      // Track if stream is closed to prevent double cleanup
      let isStreamClosed = false;
      let subscription: ReturnType<typeof eventStore.subscribe> | null = null;
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

      // Subscribe to events for this document
      const streamId = `${id.substring(0, 16)}...${Math.random().toString(36).substring(7)}`;
      console.log(`[EventStream:${streamId}] Subscribing to events for document ${id}`);
      subscription = eventStore.subscribe(id, async (storedEvent) => {
        if (isStreamClosed) {
          console.log(`[EventStream:${streamId}] Stream already closed for ${id}, ignoring event ${storedEvent.event.type}`);
          return;
        }

        console.log(`[EventStream:${streamId}] Received event ${storedEvent.event.type} for document ${id}, attempting to write to SSE stream`);

        try {
          const eventData = {
            id: storedEvent.event.id,
            type: storedEvent.event.type,
            timestamp: storedEvent.event.timestamp,
            userId: storedEvent.event.userId,
            documentId: storedEvent.event.documentId,
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
          console.log(`[EventStream:${streamId}] Successfully wrote event ${storedEvent.event.type} to SSE stream for ${id}`);
        } catch (error) {
          console.error(`[EventStream:${streamId}] Error writing event ${storedEvent.event.type} to SSE stream for ${id}:`, error);
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
        console.log(`[EventStream] Client disconnected from document events stream for ${id}`);
        cleanup();
      });

      // Return promise that resolves when stream should close
      // This keeps the SSE connection open until cleanup() is called
      return streamPromise;
    });
  });
}