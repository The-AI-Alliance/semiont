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
import type { EventBus, StoredEvent } from '@semiont/core';
import type { startMakeMeaning } from '@semiont/make-meaning';
import { getLogger } from '../logger';
import type { Subscription } from 'rxjs';

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

    // Subscribe to system-level event types on the Core EventBus
    const eventBus = c.get('eventBus');
    const streamId = `global-${Math.random().toString(36).substring(2, 9)}`;
    logger.info('Subscribing to global events', { streamId });

    const handleEvent = async (storedEvent: StoredEvent) => {
      if (isStreamClosed) return;

      try {
        const eventData = {
          id: storedEvent.id,
          type: storedEvent.type,
          timestamp: storedEvent.timestamp,
          userId: storedEvent.userId,
          resourceId: storedEvent.resourceId,
          payload: storedEvent.payload,
          metadata: {
            sequenceNumber: storedEvent.metadata.sequenceNumber,
          },
        };

        await stream.writeSSE({
          data: JSON.stringify(eventData),
          event: storedEvent.type,
          id: storedEvent.metadata.sequenceNumber.toString(),
        });
      } catch (error) {
        logger.error('Error writing event to global SSE stream', {
          streamId,
          eventType: storedEvent.type,
          error,
        });
        cleanup();
      }
    };

    // Subscribe to system-level event types
    const subscription: Subscription = eventBus.get('mark:entity-type-added').subscribe(handleEvent);

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
