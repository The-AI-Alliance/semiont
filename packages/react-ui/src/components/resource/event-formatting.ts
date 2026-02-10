/**
 * Event Formatting Utilities
 *
 * Display and formatting utilities for resource events.
 * No React dependencies - safe to use in any JavaScript environment.
 */

import type { StoredEvent, ResourceEventType } from '@semiont/core';
import type { components } from '@semiont/api-client';
import { getExactText, getTargetSelector } from '@semiont/api-client';
import { ANNOTATORS } from '../../lib/annotation-registry';

type Annotation = components['schemas']['Annotation'];
type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

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

    case 'job.completed':
    case 'job.started':
    case 'job.progress':
    case 'job.failed':
      return t('jobEvent');

    case 'representation.added':
    case 'representation.removed':
      return t('representationEvent');

    default:
      return type;
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
      // Use annotation registry as single source of truth for emojis
      if (motivation === 'highlighting') return ANNOTATORS.highlight.iconEmoji || '📝';
      if (motivation === 'linking') return ANNOTATORS.reference.iconEmoji || '📝';
      if (motivation === 'assessing') return ANNOTATORS.assessment.iconEmoji || '📝';
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

    case 'job.completed':
      return '🔗';  // Link emoji for linked document creation
    case 'job.started':
    case 'job.progress':
      return '⚙️';  // Gear for job processing
    case 'job.failed':
      return '❌';  // X mark for failed jobs

    case 'representation.added':
    case 'representation.removed':
      return '📄';

    default:
      return '📝';
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

  // Use type discriminators for proper narrowing
  switch (eventData.type) {
    case 'resource.created':
    case 'resource.cloned': {
      return { exact: eventData.payload.name, isQuoted: false, isTag: false };
    }

    // Unified annotation events
    case 'annotation.body.updated': {
      // Find current annotation to get its text
      // payload.annotationId is just the UUID, but annotation.id is the full URI
      const annotation = annotations.find(a =>
        a.id.endsWith(`/annotations/${eventData.payload.annotationId}`)
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
      // payload.annotationId is just the UUID, but annotation.id in the added event is the full URI
      const addedEvent = allEvents.find(e =>
        e.event.type === 'annotation.added' &&
        e.event.payload.annotation.id.endsWith(`/annotations/${eventData.payload.annotationId}`)
      );
      if (addedEvent && addedEvent.event.type === 'annotation.added') {
        try {
          const target = addedEvent.event.payload.annotation.target;
          if (typeof target !== 'string' && target.selector) {
            const exact = getExactText(target.selector);
            if (exact) {
              return { exact: truncateText(exact), isQuoted: true, isTag: false };
            }
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
        const target = eventData.payload.annotation.target;
        if (typeof target !== 'string' && target.selector) {
          const exact = getExactText(target.selector);
          if (exact) {
            return { exact: truncateText(exact), isQuoted: true, isTag: false };
          }
        }
      } catch {
        // If selector parsing fails, return null
      }
      return null;
    }

    case 'entitytag.added':
    case 'entitytag.removed': {
      return { exact: eventData.payload.entityType, isQuoted: false, isTag: true };
    }

    case 'job.completed': {
      // Find the annotation that was used to generate the resource
      if (eventData.payload.annotationUri) {
        const annotation = annotations.find(a =>
          a.id === eventData.payload.annotationUri
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

    case 'job.started':
    case 'job.progress':
    case 'job.failed':
    case 'representation.added':
    case 'representation.removed':
      return null;

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
    const motivation = eventData.payload.annotation.motivation;
    const body = eventData.payload.annotation.body;
    if (motivation === 'linking' && body && 'entityTypes' in body) {
      return (body as any).entityTypes ?? [];
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

  if (eventData.type === 'resource.created') {
    return {
      type: 'created',
      method: eventData.payload.creationMethod || 'unknown',
      userId: eventData.userId,
      metadata: undefined,
    };
  }

  if (eventData.type === 'resource.cloned') {
    return {
      type: 'cloned',
      method: eventData.payload.creationMethod || 'clone',
      userId: eventData.userId,
      sourceDocId: eventData.payload.parentResourceId,
      parentResourceId: eventData.payload.parentResourceId,
      metadata: undefined,
    };
  }

  return null;
}
