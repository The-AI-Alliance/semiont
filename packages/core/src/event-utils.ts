/**
 * Event Type Guards and Extraction Utilities
 *
 * Domain logic for working with resource events.
 * No React dependencies - safe to use in any JavaScript environment.
 */

import type { StoredEvent } from './event-base';
import { isAnnotationId, type AnnotationId } from './identifiers';
import { isObject, isString } from './type-guards';

/**
 * Minimal event shape accepted by event utility functions.
 * Compatible with the internal `StoredEvent` type and with the spec's
 * `StoredEventResponse` and `AttributedEvent`.
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
  };
}

// =============================================================================
// EVENT TYPE GUARDS AND EXTRACTION
// =============================================================================

/**
 * The annotation a stored event is about, or null when it is about none.
 *
 * A `mark:added` carries the annotation; a `mark:removed` and a
 * `mark:body-updated` name it by id.
 */
export function getAnnotationIdFromEvent(event: StoredEventLike): AnnotationId | null {
  const payload = event.payload;
  if (!isObject(payload)) return null;

  let id: unknown;
  if (event.type === 'mark:added') {
    id = isObject(payload.annotation) ? payload.annotation.id : undefined;
  } else if (event.type === 'mark:removed' || event.type === 'mark:body-updated') {
    id = payload.annotationId;
  }
  return isString(id) && isAnnotationId(id) ? id : null;
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

