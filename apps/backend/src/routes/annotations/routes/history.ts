import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { AnnotationsRouterType } from '../shared';
import { getEventStore } from '../../../events/event-store';
import { getGraphDatabase } from '../../../graph/factory';
import { StoredEventApiSchema } from '@semiont/core-types';

const GetAnnotationHistoryResponse = z.object({
  events: z.array(StoredEventApiSchema),
  total: z.number(),
  annotationId: z.string(),
  documentId: z.string(),
});

export const getAnnotationHistoryRoute = createRoute({
  method: 'get',
  path: '/api/documents/{documentId}/annotations/{annotationId}/history',
  summary: 'Get Annotation History',
  description: 'Get full event history for a specific annotation (highlight or reference)',
  tags: ['Selections', 'Events'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      documentId: z.string(),
      annotationId: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: GetAnnotationHistoryResponse,
        },
      },
      description: 'Annotation history retrieved successfully',
    },
    404: {
      description: 'Annotation not found',
    },
  },
});

export function registerGetAnnotationHistory(router: AnnotationsRouterType) {
  router.openapi(getAnnotationHistoryRoute, async (c) => {
    const { documentId, annotationId } = c.req.valid('param');

    // Verify annotation exists
    const graphDb = await getGraphDatabase();
    const annotation = await graphDb.getAnnotation(annotationId);
    if (!annotation) {
      throw new HTTPException(404, { message: 'Annotation not found' });
    }

    if (annotation.target.source !== documentId) {
      throw new HTTPException(404, { message: 'Annotation does not belong to this document' });
    }

    const eventStore = await getEventStore();

    // Get all events for this document
    const allEvents = await eventStore.queryEvents({
      documentId,
    });

    // Filter events related to this annotation
    const annotationEvents = allEvents.filter(stored => {
      const event = stored.event;

      // Check if event is about this annotation
      // Highlight events have highlightId, Reference events have referenceId
      if ('highlightId' in event.payload && event.payload.highlightId === annotationId) return true;
      if ('referenceId' in event.payload && event.payload.referenceId === annotationId) return true;

      return false;
    });

    // Format events for API response
    const events = annotationEvents.map(stored => ({
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

    // Sort by sequence number
    events.sort((a, b) => a.metadata.sequenceNumber - b.metadata.sequenceNumber);

    return c.json({
      events,
      total: events.length,
      annotationId,
      documentId,
    });
  });
}