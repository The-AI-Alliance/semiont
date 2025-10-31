/**
 * Event Utilities
 *
 * Pure TypeScript utilities for working with resource events.
 * No React dependencies - safe to use in any JavaScript environment.
 */

import type { paths, components } from '../types';
import { getExactText, compareAnnotationIds, getTargetSelector } from './annotations';

// Extract StoredEvent type from events endpoint response
type EventsResponse = paths['/api/resources/{id}/events']['get']['responses'][200]['content']['application/json'];
export type StoredEvent = EventsResponse['events'][number];
export type ResourceEvent = StoredEvent['event'];
export type EventMetadata = StoredEvent['metadata'];
type Annotation = components['schemas']['Annotation'];

// Event types
export type ResourceEventType =
  | 'resource.created'
  | 'resource.cloned'
  | 'resource.archived'
  | 'resource.unarchived'
  | 'annotation.added'
  | 'annotation.removed'
  | 'annotation.body.updated'
  | 'entitytag.added'
  | 'entitytag.removed'
  | 'entitytype.added'  // Global entity type collection
  | 'job.started'
  | 'job.progress'
  | 'job.completed'
  | 'job.failed';

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

// =============================================================================
// EVENT TYPE GUARDS AND EXTRACTION
// =============================================================================

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
      return payload.annotation?.id || null;

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

// =============================================================================
// EVENT FORMATTING AND DISPLAY
// =============================================================================

/**
 * Format event type for display with i18n support
 */
export function formatEventType(type: ResourceEventType, t: TranslateFn, payload?: any): string {
  switch (type) {
    case 'resource.created':
      return t('resourceCreated');
    case 'resource.cloned':
      return t('resourceCloned');
    case 'resource.archived':
      return t('resourceArchived');
    case 'resource.unarchived':
      return t('resourceUnarchived');

    case 'annotation.added': {
      const motivation = payload?.annotation?.motivation;
      if (motivation === 'highlighting') return t('highlightAdded');
      if (motivation === 'linking') return t('referenceCreated');
      if (motivation === 'assessing') return t('assessmentAdded');
      return t('annotationAdded');
    }
    case 'annotation.removed': {
      return t('annotationRemoved');
    }
    case 'annotation.body.updated': {
      return t('annotationBodyUpdated');
    }

    case 'entitytag.added':
      return t('entitytagAdded');
    case 'entitytag.removed':
      return t('entitytagRemoved');
    case 'entitytype.added':
      return t('entitytypeAdded');

    case 'job.completed':
    case 'job.started':
    case 'job.progress':
    case 'job.failed':
      return t('jobEvent');

    default:
      const _exhaustiveCheck: never = type;
      return _exhaustiveCheck;
  }
}

/**
 * Get emoji for event type
 * For unified annotation events, pass the payload to determine motivation
 */
export function getEventEmoji(type: ResourceEventType, payload?: any): string {
  switch (type) {
    case 'resource.created':
    case 'resource.cloned':
    case 'resource.archived':
    case 'resource.unarchived':
      return '📄';

    case 'annotation.added': {
      const motivation = payload?.annotation?.motivation;
      if (motivation === 'highlighting') return '🟡';
      if (motivation === 'linking') return '🔵';
      if (motivation === 'assessing') return '🔴';
      return '📝';
    }
    case 'annotation.removed': {
      return '🗑️';
    }
    case 'annotation.body.updated': {
      return '✏️';
    }

    case 'entitytag.added':
    case 'entitytag.removed':
      return '🏷️';
    case 'entitytype.added':
      return '🏷️';  // Same emoji as entitytag (global entity type collection)

    case 'job.completed':
      return '🔗';  // Link emoji for linked document creation
    case 'job.started':
    case 'job.progress':
      return '⚙️';  // Gear for job processing
    case 'job.failed':
      return '❌';  // X mark for failed jobs

    default:
      const _exhaustiveCheck: never = type;
      return _exhaustiveCheck;
  }
}

/**
 * Format timestamp as relative time with i18n support
 */
export function formatRelativeTime(timestamp: string, t: TranslateFn): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t('justNow');
  if (diffMins < 60) return t('minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('hoursAgo', { count: diffHours });
  if (diffDays < 7) return t('daysAgo', { count: diffDays });

  return date.toLocaleDateString();
}

/**
 * Helper to truncate text for display
 */
function truncateText(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? trimmed.substring(0, maxLength) + '...' : trimmed;
}

/**
 * Get display content from event payload - complete implementation
 */
export function getEventDisplayContent(
  event: StoredEvent,
  annotations: Annotation[], // Unified annotations array (all types)
  allEvents: StoredEvent[]
): { exact: string; isQuoted: boolean; isTag: boolean } | null {
  const eventData = event.event;
  const payload = eventData.payload as any;

  // Use type discriminators instead of runtime typeof checks
  switch (eventData.type) {
    case 'resource.created':
    case 'resource.cloned': {
      return { exact: payload.name, isQuoted: false, isTag: false };
    }

    // Unified annotation events
    case 'annotation.body.updated': {
      // Find current annotation to get its text
      const annotation = annotations.find(a =>
        compareAnnotationIds(a.id, payload.annotationId)
      );

      if (annotation?.target) {
        try {
          const targetSelector = getTargetSelector(annotation.target);
          const exact = getExactText(targetSelector);
          if (exact) {
            return { exact: truncateText(exact), isQuoted: true, isTag: false };
          }
        } catch {
          // If selector parsing fails, continue to return null
        }
      }
      return null;
    }

    case 'annotation.removed': {
      // Find the original annotation.added event to get the text
      const addedEvent = allEvents.find(e =>
        e.event.type === 'annotation.added' &&
        (e.event.payload as any).annotation?.id === payload.annotationId
      );
      if (addedEvent) {
        const addedPayload = addedEvent.event.payload as any;
        try {
          const exact = getExactText(addedPayload.annotation.target.selector);
          if (exact) {
            return { exact: truncateText(exact), isQuoted: true, isTag: false };
          }
        } catch {
          // If selector parsing fails, return null
        }
      }
      return null;
    }

    case 'annotation.added': {
      // New unified event structure - annotation is in payload
      try {
        const exact = getExactText(payload.annotation.target.selector);
        if (exact) {
          return { exact: truncateText(exact), isQuoted: true, isTag: false };
        }
      } catch {
        // If selector parsing fails, return null
      }
      return null;
    }

    case 'entitytag.added':
    case 'entitytag.removed': {
      return { exact: payload.entityType, isQuoted: false, isTag: true };
    }

    case 'job.completed': {
      // Find the annotation that was used to generate the resource
      if (payload.annotationId) {
        const annotation = annotations.find(a =>
          compareAnnotationIds(a.id, payload.annotationId)
        );

        if (annotation?.target) {
          try {
            const targetSelector = getTargetSelector(annotation.target);
            const exact = getExactText(targetSelector);
            if (exact) {
              return { exact: truncateText(exact), isQuoted: true, isTag: false };
            }
          } catch {
            // If selector parsing fails, continue to return null
          }
        }
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Get entity types from event payload
 */
export function getEventEntityTypes(event: StoredEvent): string[] {
  const eventData = event.event;

  if (eventData.type === 'annotation.added') {
    const payload = eventData.payload as any;
    const motivation = payload?.annotation?.motivation;
    if (motivation === 'linking') {
      return payload.annotation?.body?.entityTypes ?? [];
    }
  }

  return [];
}

/**
 * Resource creation details
 */
export interface ResourceCreationDetails {
  type: 'created' | 'cloned';
  method: string;
  userId?: string;
  sourceDocId?: string; // For cloned resources
  parentResourceId?: string;
  metadata?: Record<string, any>;
}

/**
 * Get resource creation details from event
 */
export function getResourceCreationDetails(event: StoredEvent): ResourceCreationDetails | null {
  const eventData = event.event;
  const payload = eventData.payload as any;

  if (eventData.type === 'resource.created') {
    return {
      type: 'created',
      method: payload.creationMethod || 'unknown',
      userId: eventData.userId,
      metadata: payload.metadata,
    };
  }

  if (eventData.type === 'resource.cloned') {
    return {
      type: 'cloned',
      method: payload.creationMethod || 'clone',
      userId: eventData.userId,
      sourceDocId: payload.parentResourceId,
      parentResourceId: payload.parentResourceId,
      metadata: payload.metadata,
    };
  }

  return null;
}
