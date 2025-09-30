import { createRoute, z } from '@hono/zod-openapi';
import type { DocumentsRouterType } from '../shared';
import { getEventStore } from '../../../events/event-store';
import type { EventQuery } from '@semiont/core-types';
import { StoredEventApiSchema } from '@semiont/core-types';

const GetEventsResponse = z.object({
  events: z.array(StoredEventApiSchema),
  total: z.number(),
  documentId: z.string(),
});

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
          schema: GetEventsResponse,
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
    const storedEvents = await eventStore.queryEvents(filters);

    // Format events for API response
    const events = storedEvents.map(stored => ({
      id: stored.event.id,
      type: stored.event.type,
      timestamp: stored.event.timestamp,
      userId: stored.event.userId,
      documentId: stored.event.documentId,
      payload: stored.event.payload,
      metadata: {
        sequenceNumber: stored.metadata.sequenceNumber,
        prevEventHash: stored.metadata.prevEventHash,
        checksum: stored.metadata.checksum,
      },
    }));

    return c.json({
      events,
      total: events.length,
      documentId: id,
    });
  });
}