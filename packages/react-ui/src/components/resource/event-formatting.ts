/**
 * Event Formatting Utilities
 *
 * Display and formatting utilities for resource events.
 * No React dependencies - safe to use in any JavaScript environment.
 */

import type { StoredEventLike, PersistedEventType } from '@semiont/core';
import type { components } from '@semiont/core';
import { getExactText, getTargetSelector } from '@semiont/api-client';
import { ANNOTATORS } from '../../lib/annotation-registry';

type Annotation = components['schemas']['Annotation'];
type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

// =============================================================================
// USER ID DISPLAY
// =============================================================================

/**
 * Format a DID or user ID for display.
 *
 * did:web:example.com:users:admin%40example.com → admin@example.com
 * did:web:system:smelter → Smelter
 * plain-string → plain-string
 */
export function formatUserId(userId: string): string {
  if (!userId.startsWith('did:')) return userId;

  // System actors: did:web:system:smelter → Smelter
  const systemMatch = userId.match(/^did:web:system:(.+)$/);
  if (systemMatch) {
    const name = systemMatch[1];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  // User DIDs: did:web:example.com:users:admin%40example.com → admin@example.com
  const userMatch = userId.match(/^did:web:[^:]+:users:(.+)$/);
  if (userMatch) {
    return decodeURIComponent(userMatch[1]);
  }

  return userId;
}

// =============================================================================
// EVENT FORMATTING AND DISPLAY
// =============================================================================

/**
 * Format event type for display with i18n support
 */
export function formatEventType(type: PersistedEventType, t: TranslateFn, payload?: any): string {
  switch (type) {
    case 'yield:created':
      return t('resourceCreated');
    case 'yield:cloned':
      return t('resourceCloned');
    case 'mark:archived':
      return t('resourceArchived');
    case 'mark:unarchived':
      return t('resourceUnarchived');

    case 'mark:added': {
      const motivation = payload?.annotation?.motivation;
      if (motivation === 'highlighting') return t('highlightAdded');
      if (motivation === 'linking') return t('referenceCreated');
      if (motivation === 'assessing') return t('assessmentAdded');
      return t('annotationAdded');
    }
    case 'mark:removed': {
      return t('annotationRemoved');
    }
    case 'mark:body-updated': {
      return t('annotationBodyUpdated');
    }

    case 'mark:entity-tag-added':
      return t('entitytagAdded');
    case 'mark:entity-tag-removed':
      return t('entitytagRemoved');

    case 'job:completed':
    case 'job:started':
    case 'job:progress':
    case 'job:failed':
      return t('jobEvent');

    case 'yield:representation-added':
    case 'yield:representation-removed':
      return t('representationEvent');

    default:
      return type;
  }
}

/**
 * Get emoji for event type
 * For unified annotation events, pass the payload to determine motivation
 */
export function getEventEmoji(type: PersistedEventType, payload?: any): string {
  switch (type) {
    case 'yield:created':
    case 'yield:cloned':
    case 'mark:archived':
    case 'mark:unarchived':
      return '📄';

    case 'mark:added': {
      const motivation = payload?.annotation?.motivation;
      // Use annotation registry as single source of truth for emojis
      if (motivation === 'highlighting') return ANNOTATORS.highlight.iconEmoji || '📝';
      if (motivation === 'linking') return ANNOTATORS.reference.iconEmoji || '📝';
      if (motivation === 'assessing') return ANNOTATORS.assessment.iconEmoji || '📝';
      return '📝';
    }
    case 'mark:removed': {
      return '🗑️';
    }
    case 'mark:body-updated': {
      return '✏️';
    }

    case 'mark:entity-tag-added':
    case 'mark:entity-tag-removed':
      return '🏷️';

    case 'job:completed':
      return '🔗';  // Link emoji for linked document creation
    case 'job:started':
    case 'job:progress':
      return '⚙️';  // Gear for job processing
    case 'job:failed':
      return '❌';  // X mark for failed jobs

    case 'yield:representation-added':
    case 'yield:representation-removed':
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
  event: StoredEventLike,
  annotations: Annotation[], // Unified annotations array (all types)
  allEvents: StoredEventLike[]
): { exact: string; isQuoted: boolean; isTag: boolean } | null {
  const eventData = event;
  const payload = eventData.payload as any;

  // Use type discriminators for proper narrowing
  switch (eventData.type) {
    case 'yield:created':
    case 'yield:cloned': {
      return { exact: payload.name, isQuoted: false, isTag: false };
    }

    // Unified annotation events
    case 'mark:body-updated': {
      // Find current annotation to get its text
      // payload.annotationId is just the UUID, but annotation.id is the full URI
      const annotation = annotations.find(a =>
        a.id.endsWith(`/annotations/${payload.annotationId}`)
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

    case 'mark:removed': {
      // Find the original annotation.added event to get the text
      // payload.annotationId is just the UUID, but annotation.id in the added event is the full URI
      const addedEvent = allEvents.find(e =>
        e.type === 'mark:added' &&
        (e.payload as any).annotation.id.endsWith(`/annotations/${payload.annotationId}`)
      );
      if (addedEvent && addedEvent.type === 'mark:added') {
        try {
          const target = (addedEvent.payload as any).annotation.target;
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

    case 'mark:added': {
      // New unified event structure - annotation is in payload
      try {
        const target = payload.annotation.target;
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

    case 'mark:entity-tag-added':
    case 'mark:entity-tag-removed': {
      return { exact: payload.entityType, isQuoted: false, isTag: true };
    }

    case 'job:completed': {
      // Find the annotation that was used to generate the resource
      if (payload.annotationUri) {
        const annotation = annotations.find(a =>
          a.id === payload.annotationUri
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

    case 'job:started':
    case 'job:progress':
    case 'job:failed':
    case 'yield:representation-added':
    case 'yield:representation-removed':
      return null;

    default:
      return null;
  }
}

/**
 * Get entity types from event payload
 */
export function getEventEntityTypes(event: StoredEventLike): string[] {
  const eventData = event;
  const payload = eventData.payload as any;

  if (eventData.type === 'mark:added') {
    const motivation = payload.annotation.motivation;
    const body = payload.annotation.body;
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
export function getResourceCreationDetails(event: StoredEventLike): ResourceCreationDetails | null {
  const eventData = event;
  const payload = eventData.payload as any;

  if (eventData.type === 'yield:created') {
    return {
      type: 'created',
      method: payload.creationMethod || 'unknown',
      userId: eventData.userId,
      metadata: undefined,
    };
  }

  if (eventData.type === 'yield:cloned') {
    return {
      type: 'cloned',
      method: payload.creationMethod || 'clone',
      userId: eventData.userId,
      sourceDocId: payload.parentResourceId,
      parentResourceId: payload.parentResourceId,
      metadata: undefined,
    };
  }

  return null;
}
