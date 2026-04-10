import { EventQuery } from '@semiont/event-sourcing';

/**
 * Resource Events Stream Route
 *
 * Long-lived per-resource SSE stream. Carries every persisted event for the
 * resource as an EnrichedResourceEvent (StoredEventResponse + optional
 * post-materialization annotation). The single delivery channel for both
 * local and remote mutations on a resource.
 *
 * Supports the W3C SSE Last-Event-ID replay mechanism: clients reconnecting
 * after a network blip pass their last seen sequenceNumber via the
 * Last-Event-ID header, and the server replays missed events from the log
 * before resuming live delivery. Bounded by REPLAY_WINDOW_CAP — clients
 * disconnected for too long get a replay-window-exceeded event and are
 * expected to do a cold refetch via their store.
 */

import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { resourceId, type ResourceId, type StoredEvent, type components, PERSISTED_EVENT_TYPES } from '@semiont/core';
import { SSE_STREAM_CONNECTED } from '@semiont/api-client';
import { getLogger } from '../../../logger';
import { Subscription } from 'rxjs';
import type { KnowledgeBase } from '@semiont/make-meaning';
import { readAnnotationFromView, eventAnnotationId } from './event-stream-enrichment';

type EnrichedResourceEvent = components['schemas']['EnrichedResourceEvent'];

/**
 * Maximum number of events the server will replay on reconnect before giving up
 * and sending replay-window-exceeded. Protects against unbounded replay for
 * clients that have been disconnected for hours.
 */
const REPLAY_WINDOW_CAP = 1000;

/**
 * Build an EnrichedResourceEvent from a StoredEvent, populating the annotation
 * field via the materialized view if the event mutates an annotation.
 */
async function buildEnrichedEvent(
  storedEvent: StoredEvent,
  kb: KnowledgeBase,
  rId: ResourceId,
): Promise<EnrichedResourceEvent> {
  const enriched: EnrichedResourceEvent = {
    id: storedEvent.id,
    type: storedEvent.type,
    timestamp: storedEvent.timestamp,
    userId: storedEvent.userId,
    resourceId: storedEvent.resourceId,
    version: storedEvent.version,
    payload: storedEvent.payload,
    metadata: {
      sequenceNumber: storedEvent.metadata.sequenceNumber,
      streamPosition: storedEvent.metadata.streamPosition,
      ...(storedEvent.metadata.prevEventHash !== undefined && { prevEventHash: storedEvent.metadata.prevEventHash }),
      ...(storedEvent.metadata.checksum !== undefined && { checksum: storedEvent.metadata.checksum }),
      ...(storedEvent.metadata.correlationId !== undefined && { correlationId: storedEvent.metadata.correlationId }),
    },
  };

  // For events that mutate an annotation, populate the enrichment field with
  // the post-materialization annotation. EventStore.appendEvent awaits
  // materializeResource before publishing, so the view is guaranteed up-to-date.
  const aid = eventAnnotationId(storedEvent);
  if (aid !== null) {
    const annotation = await readAnnotationFromView(kb, rId, aid);
    if (annotation !== null) {
      enriched.annotation = annotation;
    }
  }

  return enriched;
}

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

    const logger = getLogger().child({
      component: 'events-stream',
      resourceId: id
    });

    const rId = resourceId(id);

    // Read Last-Event-ID header for replay-on-reconnect. The header carries
    // the sequenceNumber of the most recent event the client received before
    // its previous connection dropped.
    const lastEventIdHeader = c.req.header('Last-Event-ID');
    const lastEventId = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : null;
    const isReconnect = lastEventId !== null && !Number.isNaN(lastEventId);

    logger.info('Client connecting to resource events stream', {
      resourceId: rId,
      isReconnect,
      lastEventId,
    });

    // Verify resource exists in event store (Event Store - source of truth)
    const eventBus = c.get('eventBus');
    const { knowledgeSystem: { kb } } = c.get('makeMeaning');
    const { eventStore } = kb;
    const query = new EventQuery(eventStore.log.storage);
    const events = await query.getResourceEvents(rId);
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
      const subscriptions: Subscription[] = [];
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

        for (const sub of subscriptions) sub.unsubscribe();

        // Close the stream by resolving the promise
        if (closeStreamCallback) {
          closeStreamCallback();
        }
      };

      const streamId = `${id.substring(0, 16)}...${Math.random().toString(36).substring(7)}`;

      // Shared write path used by both replay and live event delivery.
      const writeEnrichedEvent = async (storedEvent: StoredEvent): Promise<void> => {
        if (isStreamClosed) return;
        try {
          const enriched = await buildEnrichedEvent(storedEvent, kb, rId);
          const jsonData = JSON.stringify(enriched);
          await stream.writeSSE({
            data: jsonData,
            event: storedEvent.type,
            id: storedEvent.metadata.sequenceNumber.toString(),
          });
        } catch (error) {
          logger.error('Error writing event to SSE stream', {
            streamId,
            eventType: storedEvent.type,
            error,
          });
          cleanup();
        }
      };

      // ── Replay missed events on reconnect (Last-Event-ID) ────────────────
      //
      // If the client reconnected with a Last-Event-ID, replay every event
      // since that sequence number BEFORE subscribing to live events. The
      // ordering matters: live subscription must be set up after replay
      // finishes so the client sees no gap and no duplicate.
      //
      // If the replay window exceeds REPLAY_WINDOW_CAP, send a
      // replay-window-exceeded event and skip the replay. The client is
      // expected to do a cold refetch via its store. Live delivery resumes
      // immediately after.
      if (isReconnect && lastEventId !== null) {
        const missedEvents = events.filter((e) => e.metadata.sequenceNumber > lastEventId);

        if (missedEvents.length > REPLAY_WINDOW_CAP) {
          logger.warn('Replay window exceeded — client must do a cold refetch', {
            streamId,
            lastEventId,
            missedCount: missedEvents.length,
            cap: REPLAY_WINDOW_CAP,
          });
          await stream.writeSSE({
            data: JSON.stringify({
              resourceId: id,
              lastEventId,
              missedCount: missedEvents.length,
              cap: REPLAY_WINDOW_CAP,
              message: 'Replay window exceeded — refetch state from your store',
            }),
            event: 'replay-window-exceeded',
            id: String(Date.now()),
          });
        } else if (missedEvents.length > 0) {
          logger.info('Replaying missed events', {
            streamId,
            lastEventId,
            count: missedEvents.length,
          });
          for (const missed of missedEvents) {
            if (isStreamClosed) break;
            await writeEnrichedEvent(missed);
          }
          logger.info('Replay complete', { streamId, replayed: missedEvents.length });
        }
      }

      // ── Subscribe to live events on the resource-scoped EventBus ─────────
      //
      // Subscribe AFTER replay so live events queued during the replay window
      // are seen by the new subscription, not lost between replay and live.
      logger.info('Subscribing to live events for resource', { streamId, resourceId: rId });
      const scopedBus = eventBus.scope(String(rId));

      // Subscribe to every resource-scoped persisted event type. The list is
      // derived at compile time from PersistedEventType (see persisted-events.ts):
      // adding a new event type to the catalog without adding it here is a
      // build error, not a silent runtime drop. mark:entity-type-added is a
      // system event with no resourceId so it's not delivered on the scoped
      // bus and is filtered here.
      for (const eventType of PERSISTED_EVENT_TYPES) {
        if (eventType === 'mark:entity-type-added') continue;
        subscriptions.push(
          scopedBus.getDomainEvent(eventType).subscribe(writeEnrichedEvent)
        );
      }

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
