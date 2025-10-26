/**
 * Document Events Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Manual query parameter parsing and validation
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import type { DocumentsRouterType } from '../shared';
import { createEventStore, createEventQuery } from '../../../services/event-store-service';
import type { EventQuery, StoredEvent } from '@semiont/core';
import type { components } from '@semiont/api-client';
import { HTTPException } from 'hono/http-exception';
import { getFilesystemConfig } from '../../../config/environment-loader';

type GetEventsResponse = components['schemas']['GetEventsResponse'];

const eventTypes = [
  'document.created',
  'document.cloned',
  'document.archived',
  'document.unarchived',
  'annotation.added',
  'annotation.removed',
  'annotation.body.updated',
  'entitytag.added',
  'entitytag.removed',
] as const;

// Type guard function for event type validation
function isValidEventType(type: string): type is typeof eventTypes[number] {
  return eventTypes.includes(type as any);
}

export function registerGetEvents(router: DocumentsRouterType) {
  /**
   * GET /api/documents/:id/events
   *
   * Get full event history for a document with optional filtering
   * Requires authentication
   *
   * Query parameters:
   * - type: Event type filter (optional)
   * - userId: User ID filter (optional)
   * - limit: Maximum number of events (1-1000, default: 100)
   */
  router.get('/api/documents/:id/events', async (c) => {
    const { id } = c.req.param();
    const queryParams = c.req.query();
    const basePath = getFilesystemConfig().path;

    // Parse and validate query parameters
    const type = queryParams.type;
    const userId = queryParams.userId;
    const limit = queryParams.limit ? Number(queryParams.limit) : 100;

    // Validate type if provided
    if (type && !isValidEventType(type)) {
      throw new HTTPException(400, { message: `Invalid event type. Must be one of: ${eventTypes.join(', ')}` });
    }

    // Validate limit range
    if (limit < 1 || limit > 1000) {
      throw new HTTPException(400, { message: 'Query parameter "limit" must be between 1 and 1000' });
    }

    const eventStore = await createEventStore(basePath);
    const eventQuery = createEventQuery(eventStore);

    // Build query filters - type is validated by this point
    const validatedType = type && isValidEventType(type) ? type : undefined;
    const filters: EventQuery = {
      documentId: id,
      ...(validatedType && { eventTypes: [validatedType] }),
    };

    if (userId) {
      filters.userId = userId;
    }

    if (limit) {
      filters.limit = limit;
    }

    // Query events
    const storedEvents: StoredEvent[] = await eventQuery.queryEvents(filters);

    if (!storedEvents || storedEvents.length === 0) {
      const emptyResponse: GetEventsResponse = {
        events: [],
        total: 0,
        documentId: id,
      };
      return c.json(emptyResponse);
    }

    // Validate and transform events to match API response structure
    const events = storedEvents.map(stored => {
      // Validate required top-level properties
      if (!stored.event) {
        throw new Error(`Event missing 'event' property for document ${id}`);
      }
      if (!stored.metadata) {
        throw new Error(`Event missing 'metadata' property for document ${id}`);
      }

      // Validate required event properties
      const { event, metadata } = stored;
      if (!event.id || !event.type || !event.timestamp || !event.userId || !event.documentId) {
        throw new Error(`Event ${event.id || 'unknown'} for document ${id} is missing required properties: ${JSON.stringify({ id: event.id, type: event.type, timestamp: event.timestamp, userId: event.userId, documentId: event.documentId })}`);
      }
      if (metadata.sequenceNumber === undefined) {
        throw new Error(`Event ${event.id} for document ${id} is missing metadata.sequenceNumber`);
      }

      // Return nested structure matching StoredEvent interface
      return {
        event: {
          id: event.id,
          type: event.type,
          timestamp: event.timestamp,
          userId: event.userId,
          documentId: event.documentId,
          payload: event.payload,
        },
        metadata: {
          sequenceNumber: metadata.sequenceNumber,
          prevEventHash: metadata.prevEventHash,
          checksum: metadata.checksum,
        },
      };
    });

    const response: GetEventsResponse = {
      events,
      total: events.length,
      documentId: id,
    };

    return c.json(response);
  });
}
