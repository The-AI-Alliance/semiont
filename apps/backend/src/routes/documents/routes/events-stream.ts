import { createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { DocumentsRouterType } from '../shared';
import { getEventStore } from '../../../events/event-store';
import { getGraphDatabase } from '../../../graph/factory';

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
    const user = c.get('user');

    // Verify document exists before opening stream
    const graphDb = await getGraphDatabase();
    const document = await graphDb.getDocument(id);
    if (!document) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    console.log(`[EventStream] Opening stream for document ${id}, user ${user.id}`);

    return streamSSE(c, async (stream) => {
      const eventStore = await getEventStore();

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

      // Subscribe to events for this document
      const subscription = eventStore.subscribe(id, async (storedEvent) => {
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
          console.error(`[EventStream] Error writing to stream:`, error);
          // Stream likely closed, subscription will be cleaned up below
        }
      });

      // Keep-alive ping every 30 seconds
      const keepAliveInterval = setInterval(async () => {
        try {
          // Send a comment (keep-alive) using data field
          await stream.writeSSE({
            data: ':keep-alive',
          });
        } catch (error) {
          // Stream closed, interval will be cleared below
          clearInterval(keepAliveInterval);
        }
      }, 30000);

      // Cleanup on disconnect
      c.req.raw.signal.addEventListener('abort', () => {
        console.log(`[EventStream] Client disconnected from document ${id}`);
        clearInterval(keepAliveInterval);
        subscription.unsubscribe();

        const remainingCount = eventStore.getSubscriptionCount(id);
        console.log(`[EventStream] Remaining subscribers for document ${id}: ${remainingCount}`);
      });

      // Log active subscription
      const subscriberCount = eventStore.getSubscriptionCount(id);
      console.log(`[EventStream] Active subscribers for document ${id}: ${subscriberCount}`);
    });
  });
}