/**
 * Annotation History Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No request body validation needed (GET route with only path params)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import type { AnnotationsRouterType } from '../shared';
import { createEventStore, createEventQuery } from '../../../services/event-store-service';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { getTargetSource } from '../../../lib/annotation-utils';
import type { components } from '@semiont/api-client';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';

type GetAnnotationHistoryResponse = components['schemas']['GetAnnotationHistoryResponse'];

export function registerGetAnnotationHistory(router: AnnotationsRouterType) {
  /**
   * GET /api/resources/:resourceId/annotations/:annotationId/history
   *
   * Get full event history for a specific annotation (highlight or reference)
   * Requires authentication
   * Returns annotation events sorted by sequence number
   */
  router.get('/api/resources/:resourceId/annotations/:annotationId/history', async (c) => {
    const { resourceId, annotationId } = c.req.param();
    const config = c.get('config');

    // Verify annotation exists using Layer 3 (not GraphDB)
    const annotation = await AnnotationQueryService.getAnnotation(makeAnnotationId(annotationId), makeResourceId(resourceId), config);
    if (!annotation) {
      throw new HTTPException(404, { message: 'Annotation not found' });
    }

    if (getTargetSource(annotation.target) !== resourceId) {
      throw new HTTPException(404, { message: 'Annotation does not belong to this resource' });
    }

    const eventStore = await createEventStore( config);
    const query = createEventQuery(eventStore);

    // Get all events for this resource
    const allEvents = await query.queryEvents({
      resourceId,
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
    const events: GetAnnotationHistoryResponse['events'] = annotationEvents.map(stored => ({
      id: stored.event.id,
      type: stored.event.type as any, // Job events are filtered out above but TS doesn't know
      timestamp: stored.event.timestamp,
      userId: stored.event.userId,
      resourceId: stored.event.resourceId!, // Map internal resourceId to API resourceId
      payload: stored.event.payload as any,
      metadata: {
        sequenceNumber: stored.metadata.sequenceNumber,
        prevEventHash: stored.metadata.prevEventHash,
        checksum: stored.metadata.checksum,
      },
    }));

    // Sort by sequence number
    events.sort((a, b) => a.metadata.sequenceNumber - b.metadata.sequenceNumber);

    const response: GetAnnotationHistoryResponse = {
      events,
      total: events.length,
      annotationId,
      resourceId: resourceId, // Map internal resourceId to API resourceId
    };

    return c.json(response);
  });
}
