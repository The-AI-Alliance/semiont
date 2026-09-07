/**
 * Event Type Guards and Extraction Utilities
 *
 * Domain logic for working with resource events.
 * No React dependencies - safe to use in any JavaScript environment.
 */
import type { StoredEvent } from './event-base';
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
    type: string;
    timestamp: string;
    userId: string;
    resourceId?: string;
    payload?: unknown;
    metadata: {
        sequenceNumber: number;
    };
}
/**
 * Extract annotation ID from event payload
 * Returns null if event is not annotation-related
 *
 * For mark:added: extracts full URI from payload.annotation.id
 * For mark:removed/mark:body-updated: constructs full URI from payload.annotationId (UUID) + resourceId
 */
export declare function getAnnotationUriFromEvent(event: StoredEventLike): AnnotationUri | null;
/**
 * Check if an event is related to a specific annotation
 */
export declare function isEventRelatedToAnnotation(event: StoredEventLike, annotationUri: AnnotationUri): boolean;
/**
 * Type guard to check if an object is a StoredEvent (flat shape)
 */
export declare function isStoredEvent(event: any): event is StoredEvent;
