import { createRoute, z } from '@hono/zod-openapi';
import type { DocumentsRouterType } from '../shared';
import { getEventStore } from '../../../events/event-store';
import { GetEventsResponseSchema, type GetEventsResponse, type EventQuery, type StoredEvent } from '@semiont/core-types';

const eventTypes = [
  'document.created',
  'document.cloned',
  'document.archived',
  'document.unarchived',
  'highlight.added',
  'highlight.removed',
  'reference.created',
  'reference.resolved',
  'reference.deleted',
  'entitytag.added',
  'entitytag.removed',
] as const;

export const getEventsRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/events',
  summary: 'Get Document Event History',
  description: 'Get full event history for a document with optional filtering',
  tags: ['Documents', 'Events'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    query: z.object({
      type: z.enum(eventTypes).optional(),
      userId: z.string().optional(),
      limit: z.coerce.number().min(1).max(1000).default(100).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: GetEventsResponseSchema,
        },
      },
      description: 'Events retrieved successfully',
    },
  },
});

export function registerGetEvents(router: DocumentsRouterType) {
  router.openapi(getEventsRoute, async (c) => {
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');

    const eventStore = await getEventStore();

    // Build query filters
    const filters: EventQuery = {
      documentId: id,
    };

    if (query.type) {
      filters.eventTypes = [query.type];
    }

    if (query.userId) {
      filters.userId = query.userId;
    }

    if (query.limit) {
      filters.limit = query.limit;
    }

    // Query events
    const storedEvents: StoredEvent[] = await eventStore.queryEvents(filters);

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