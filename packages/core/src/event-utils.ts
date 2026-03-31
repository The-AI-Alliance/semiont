/**
 * Event Type Guards and Extraction Utilities
 *
 * Domain logic for working with resource events.
 * No React dependencies - safe to use in any JavaScript environment.
 */

import type { StoredEvent } from './events';
import type { AnnotationUri } from './branded-types';

/**
 * Minimal event shape accepted by event utility functions.
 * Compatible with both the internal `StoredEvent` type and the OpenAPI-derived
 * schema type (`GetEventsResponse['events'][number]`), which lacks `version`
 * on the inner event.
 */
export interface StoredEventLike {
  event: {
    id: string;
    type: string;
    timestamp: string;
    userId: string;
    resourceId?: string;
    payload?: unknown;
  };
  metadata: {
    sequenceNumber: number;
    prevEventHash?: string;
    checksum?: string;
  };
}

// =============================================================================
// EVENT TYPE GUARDS AND EXTRACTION
// =============================================================================

/**
 * Extract annotation ID from event payload
 * Returns null if event is not annotation-related
 *
 * For annotation.added: extracts full URI from payload.annotation.id
 * For annotation.removed/body.updated: constructs full URI from payload.annotationId (UUID) + resourceId
 */
export function getAnnotationUriFromEvent(event: StoredEventLike): AnnotationUri | null {
  const eventData = event.event;
  const payload = eventData.payload as Record<string, any> | undefined;

  if (eventData.type === 'annotation.added') {
    // annotation.added has the full annotation object with id as full URI
    return payload?.annotation?.id as AnnotationUri || null;
  }

  if (eventData.type === 'annotation.removed' || eventData.type === 'annotation.body.updated') {
    // These events have annotationId (UUID only), need to construct full URI
    // Extract base URL from resourceId (format: http://host/resources/id)
    if (payload?.annotationId && eventData.resourceId) {
      try {
        const resourceUri = eventData.resourceId;
        // Extract base URL by removing the /resources/{id} part
        const baseUrl = resourceUri.substring(0, resourceUri.lastIndexOf('/resources/'));
        return `${baseUrl}/annotations/${payload.annotationId}` as AnnotationUri;
      } catch (e) {
        return null;
      }
    }
  }

  return null;
}

/**
 * Check if an event is related to a specific annotation
 */
export function isEventRelatedToAnnotation(event: StoredEventLike, annotationUri: AnnotationUri): boolean {
  const eventAnnotationUri = getAnnotationUriFromEvent(event);
  return eventAnnotationUri === annotationUri;
}

/**
 * Type guard to check if event is a resource event
 */
export function isResourceEvent(event: any): event is StoredEvent {
  return event &&
    typeof event.event === 'object' &&
    typeof event.event.id === 'string' &&
    typeof event.event.timestamp === 'string' &&
    typeof event.event.resourceId === 'string' &&
    typeof event.event.type === 'string' &&
    typeof event.metadata === 'object' &&
    typeof event.metadata.sequenceNumber === 'number';
}
