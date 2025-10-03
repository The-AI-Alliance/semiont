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

    // Verify document exists in event store (Layer 2 - source of truth)
    const eventStore = await getEventStore();
    const events = await eventStore.getDocumentEvents(id);
    if (events.length === 0) {
      throw new HTTPException(404, { message: 'Document not found - no events exist for this document' });
    }

    return streamSSE(c, async (stream) => {

      // Send initial connection message
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
      subscription = eventStore.subscribe(id, async (storedEvent) => {
        if (isStreamClosed) return;

        try {
          await stream.writeSSE({
            data: JSON.stringify({
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
            }),
            event: storedEvent.event.type,
            id: storedEvent.metadata.sequenceNumber.toString(),
          });
        } catch (error) {
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
        cleanup();
      });

      // Return promise that resolves when stream should close
      // This keeps the SSE connection open until cleanup() is called
      return streamPromise;
    });
  });
}