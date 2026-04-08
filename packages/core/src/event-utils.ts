/**
 * Event Type Guards and Extraction Utilities
 *
 * Domain logic for working with resource events.
 * No React dependencies - safe to use in any JavaScript environment.
 */

import type { StoredEvent } from './stored-events';
import type { AnnotationUri } from './branded-types';

/**
 * Minimal event shape accepted by event utility functions.
 * Compatible with both the internal `StoredEvent` type and the OpenAPI-derived
 * schema type (`GetEventsResponse['events'][number]`), which lacks `version`.
 *
 * Flat shape — event fields and metadata are peers (no `event` wrapper).
 */
export interface StoredEventLike {
  id: string;
  type: string; // Intentionally loose — accepts OpenAPI-derived types where type is string
  timestamp: string;
  userId: string;
  resourceId?: string;
  payload?: unknown;
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
 * For mark:added: extracts full URI from payload.annotation.id
 * For mark:removed/mark:body-updated: constructs full URI from payload.annotationId (UUID) + resourceId
 */
export function getAnnotationUriFromEvent(event: StoredEventLike): AnnotationUri | null {
  const payload = event.payload as Record<string, any> | undefined;

  if (event.type === 'mark:added') {
    return payload?.annotation?.id as AnnotationUri || null;
  }

  if (event.type === 'mark:removed' || event.type === 'mark:body-updated') {
    if (payload?.annotationId && event.resourceId) {
      try {
        const resourceUri = event.resourceId;
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
 * Type guard to check if an object is a StoredEvent (flat shape)
 */
export function isStoredEvent(event: any): event is StoredEvent {
  return event &&
    typeof event.id === 'string' &&
    typeof event.timestamp === 'string' &&
    typeof event.type === 'string' &&
    typeof event.metadata === 'object' &&
    typeof event.metadata.sequenceNumber === 'number';
}

