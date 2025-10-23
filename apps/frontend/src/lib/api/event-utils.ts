/**
 * Event Utilities
 *
 * Helper functions for working with document events
 * Simplified version for frontend use
 */

import type { paths } from '@semiont/api-client';

// Extract StoredEvent type from events endpoint response
type EventsResponse = paths['/api/documents/{id}/events']['get']['responses'][200]['content']['application/json'];
export type StoredEvent = EventsResponse['events'][number];
export type DocumentEvent = StoredEvent['event'];
export type EventMetadata = StoredEvent['metadata'];

// Event types
export type DocumentEventType =
  | 'document.created'
  | 'document.cloned'
  | 'document.archived'
  | 'document.unarchived'
  | 'annotation.added'
  | 'annotation.removed'
  | 'annotation.body.updated'
  | 'entitytag.added'
  | 'entitytag.removed';

/**
 * Extract annotation ID from event payload
 * Returns null if event is not annotation-related
 */
export function getAnnotationIdFromEvent(event: StoredEvent): string | null {
  const eventData = event.event;
  const payload = eventData.payload as any;

  if (!payload) {
    return null;
  }

  switch (eventData.type) {
    case 'annotation.added':
    case 'annotation.removed':
    case 'annotation.body.updated':
      return payload.annotationId || null;

    default:
      return null;
  }
}

/**
 * Check if an event is related to a specific annotation
 */
export function isEventRelatedToAnnotation(event: StoredEvent, annotationId: string): boolean {
  const eventAnnotationId = getAnnotationIdFromEvent(event);
  return eventAnnotationId === annotationId;
}

/**
 * Type guard to check if event is a document event
 */
export function isDocumentEvent(event: any): event is StoredEvent {
  return event &&
    typeof event.event === 'object' &&
    typeof event.event.id === 'string' &&
    typeof event.event.timestamp === 'string' &&
    typeof event.event.documentId === 'string' &&
    typeof event.event.type === 'string' &&
    typeof event.metadata === 'object' &&
    typeof event.metadata.sequenceNumber === 'number';
}
