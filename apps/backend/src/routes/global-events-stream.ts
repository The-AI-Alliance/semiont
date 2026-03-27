/**
 * Global Events Stream Route
 *
 * SSE endpoint for system-level domain events (not scoped to a specific resource).
 * Used by the frontend to receive real-time updates for:
 * - Entity type additions/removals
 * - Any future system-level events
 *
 * Resource-scoped events are delivered via GET /resources/:id/events/stream instead.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { User } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { SSE_STREAM_CONNECTED } from '@semiont/api-client';
import type { EventBus } from '@semiont/core';
import type { startMakeMeaning } from '@semiont/make-meaning';
import { getLogger } from '../logger';

const getRouteLogger = () => getLogger().child({ component: 'global-events-stream' });

export const globalEventsRouter = new Hono<{ Variables: { user: User; eventBus: EventBus; makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>> } }>();
globalEventsRouter.use('/api/events/stream', authMiddleware);

/**
 * GET /api/events/stream
 *
 * Open a Server-Sent Events stream to receive system-level domain events.
 * Subscribes globally to the event store — receives all domain events across all resources.
 *
 * The frontend uses this to invalidate queries when system-level events occur
 * (e.g., entity type added → invalidate entity types query).
 */
globalEventsRouter.get('/api/events/stream', async (c) => {
  const logger = getRouteLogger();

  logger.info('Client connecting to global events stream');

  const { knowledgeSystem: { kb: { eventStore } } } = c.get('makeMeaning');

  return streamSSE(c, async (stream) => {
    // Send initial connection message
    await stream.writeSSE({
      data: JSON.stringify({
        type: 'connected',
        timestamp: new Date().toISOString(),
        message: 'Global event stream connected',
      }),
      event: SSE_STREAM_CONNECTED,
      id: String(Date.now()),
    });

    let isStreamClosed = false;
    let keepAliveInterval: NodeJS.Timeout | null = null;
    let closeStreamCallback: (() => void) | null = null;

    const streamPromise = new Promise<void>((resolve) => {
      closeStreamCallback = resolve;
    });

    const cleanup = () => {
      if (isStreamClosed) return;
      isStreamClosed = true;

      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
      }

      if (subscription) {
        subscription.unsubscribe();
      }

      if (closeStreamCallback) {
        closeStreamCallback();
      }
    };

    // Subscribe globally — receives all domain events across all resources
    const streamId = `global-${Math.random().toString(36).substring(2, 9)}`;
    logger.info('Subscribing to global events', { streamId });

    const subscription = eventStore.bus.subscribeGlobal(async (storedEvent) => {
      if (isStreamClosed) return;

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

        await stream.writeSSE({
          data: JSON.stringify(eventData),
          event: storedEvent.event.type,
          id: storedEvent.metadata.sequenceNumber.toString(),
        });
      } catch (error) {
        logger.error('Error writing event to global SSE stream', {
          streamId,
          eventType: storedEvent.event.type,
          error,
        });
        cleanup();
      }
    });

    // Keep-alive ping every 30 seconds
    keepAliveInterval = setInterval(async () => {
      if (isStreamClosed) {
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        return;
      }

      try {
        await stream.writeSSE({ data: ':keep-alive' });
      } catch {
        cleanup();
      }
    }, 30000);

    // Cleanup on disconnect
    c.req.raw.signal.addEventListener('abort', () => {
      logger.info('Client disconnected from global events stream', { streamId });
      cleanup();
    });

    return streamPromise;
  });
});
