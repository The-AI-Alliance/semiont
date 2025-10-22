/**
 * Utility functions for AnnotationHistory component
 * Extracted to reduce component complexity and improve testability
 *
 * NOTE: This file contains UI-specific logic and should eventually move to the frontend package.
 * It has been updated to work with unified annotation events (annotation.added/removed/resolved)
 * instead of separate highlight/reference/assessment events.
 */

import type {
  StoredEvent,
  DocumentEventType,
  DocumentCreatedEvent,
  DocumentClonedEvent,
  AnnotationAddedEvent,
  AnnotationRemovedEvent,
  AnnotationResolvedEvent,
  EntityTagAddedEvent,
  EntityTagRemovedEvent,
} from './events';
import type { CreationMethod } from './creation-methods';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText } from './selector-utils';

// Import OpenAPI types
type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

// Format event type for display
export function formatEventType(type: DocumentEventType, t: TranslateFn): string {
  // Using a switch for exhaustive checking - TypeScript will error if we miss a case
  switch (type) {
    case 'document.created':
      return t('documentCreated');
    case 'document.cloned':
      return t('documentCloned');
    case 'document.archived':
      return t('documentArchived');
    case 'document.unarchived':
      return t('documentUnarchived');
    case 'annotation.added':
      return t('annotationAdded');
    case 'annotation.removed':
      return t('annotationRemoved');
    case 'annotation.resolved':
      return t('annotationResolved');
    case 'entitytag.added':
      return t('entitytagAdded');
    case 'entitytag.removed':
      return t('entitytagRemoved');
    default:
      // Exhaustive check: if we get here, we missed a case
      const _exhaustiveCheck: never = type;
      return _exhaustiveCheck;
  }
}

// Get emoji for annotation based on motivation
function getMotivationEmoji(motivation: Motivation): string {
  switch (motivation) {
    case 'highlighting':
      return '🟡';
    case 'linking':
      return '🔵';
    case 'assessing':
      return '🔴';
    case 'bookmarking':
      return '🔖';
    case 'commenting':
      return '💬';
    case 'tagging':
      return '🏷️';
    default:
      return '📝';
  }
}

// Get emoji for event type
export function getEventEmoji(type: DocumentEventType, event?: StoredEvent): string {
  // Using a switch for exhaustive checking - TypeScript will error if we miss a case
  switch (type) {
    case 'document.created':
    case 'document.cloned':
    case 'document.archived':
    case 'document.unarchived':
      return '📄';
    case 'annotation.added':
      if (event) {
        const payload = event.event.payload as AnnotationAddedEvent['payload'];
        return getMotivationEmoji(payload.annotation.motivation);
      }
      return '📝';
    case 'annotation.removed':
      return '🗑️';
    case 'annotation.resolved':
      return '🔗';
    case 'entitytag.added':
    case 'entitytag.removed':
      return '🏷️';
    default:
      // Exhaustive check: if we get here, we missed a case
      const _exhaustiveCheck: never = type;
      return _exhaustiveCheck;
  }
}

// Format relative time
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

// Helper to truncate text for display
function truncateText(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? trimmed.substring(0, maxLength) + '...' : trimmed;
}

// Extract display content from event payload
export function getEventDisplayContent(
  event: StoredEvent,
  _references: Annotation[], // underscore prefix to indicate intentionally unused for now
  _highlights: Annotation[], // underscore prefix to indicate intentionally unused for now
  allEvents: StoredEvent[]
): { exact: string; isQuoted: boolean; isTag: boolean } | null {
  const eventData = event.event;

  // Use type discriminators instead of runtime typeof checks
  switch (eventData.type) {
    case 'document.created':
    case 'document.cloned': {
      const payload = eventData.payload as DocumentCreatedEvent['payload'] | DocumentClonedEvent['payload'];
      return { exact: payload.name, isQuoted: false, isTag: false };
    }

    case 'annotation.resolved': {
      const payload = eventData.payload as AnnotationResolvedEvent['payload'];

      // Find the original annotation.added event to get the text
      const addedEvent = allEvents.find(e =>
        e.event.type === 'annotation.added' &&
        (e.event.payload as AnnotationAddedEvent['payload']).annotation.id === payload.annotationId
      );

      if (addedEvent) {
        const addedPayload = addedEvent.event.payload as AnnotationAddedEvent['payload'];
        return { exact: truncateText(getAnnotationExactText(addedPayload.annotation)), isQuoted: true, isTag: false };
      }
      return null;
    }

    case 'annotation.removed': {
      const payload = eventData.payload as AnnotationRemovedEvent['payload'];

      // Find the original annotation.added event
      const addedEvent = allEvents.find(e =>
        e.event.type === 'annotation.added' &&
        (e.event.payload as AnnotationAddedEvent['payload']).annotation.id === payload.annotationId
      );

      if (addedEvent) {
        const addedPayload = addedEvent.event.payload as AnnotationAddedEvent['payload'];
        return { exact: truncateText(getAnnotationExactText(addedPayload.annotation)), isQuoted: true, isTag: false };
      }
      return null;
    }

    case 'annotation.added': {
      const payload = eventData.payload as AnnotationAddedEvent['payload'];
      return { exact: truncateText(getAnnotationExactText(payload.annotation)), isQuoted: true, isTag: false };
    }

    case 'entitytag.added':
    case 'entitytag.removed': {
      const payload = eventData.payload as EntityTagAddedEvent['payload'] | EntityTagRemovedEvent['payload'];
      return { exact: payload.entityType, isQuoted: false, isTag: true };
    }

    default:
      return null;
  }
}

// Extract entity types from event payload
export function getEventEntityTypes(event: StoredEvent): string[] {
  const eventData = event.event;

  if (eventData.type === 'annotation.added') {
    const payload = eventData.payload as AnnotationAddedEvent['payload'];
    // Phase 1: Entity types are temporarily at annotation level
    return payload.annotation.entityTypes ?? [];
  }

  return [];
}

// Format user ID for display
function formatUserId(userId: string): string {
  // If it's a DID format (did:web:org.com:users:alice), format as alice@org.com
  if (userId.startsWith('did:web:')) {
    const parts = userId.split(':');
    // Format: did:web:org.com:users:alice
    // parts: ['did', 'web', 'org.com', 'users', 'alice']
    if (parts.length >= 5) {
      const domain = parts[2]; // org.com
      const username = parts[parts.length - 1]; // alice
      return `${username}@${domain}`;
    }
    // Fallback if format is unexpected
    const username = parts[parts.length - 1];
    return username || userId.substring(0, 8);
  }

  // Otherwise show first 8 characters of UUID
  return userId.substring(0, 8);
}

// Document creation details - discriminated by event type
type DocumentCreatedDetails = {
  type: 'created';
  userId: string;
  method: CreationMethod;
};

type DocumentClonedDetails = {
  type: 'cloned';
  userId: string;
  method: CreationMethod;
  sourceDocId: string;
};

export type DocumentCreationDetails = DocumentCreatedDetails | DocumentClonedDetails;

// Extract additional metadata for document creation events
export function getDocumentCreationDetails(event: StoredEvent): DocumentCreationDetails | null {
  const eventData = event.event;

  if (eventData.type === 'document.created') {
    const payload = eventData.payload as DocumentCreatedEvent['payload'];

    return {
      type: 'created',
      userId: formatUserId(eventData.userId),
      method: payload.creationMethod,
    };
  }

  if (eventData.type === 'document.cloned') {
    const payload = eventData.payload as DocumentClonedEvent['payload'];

    return {
      type: 'cloned',
      userId: formatUserId(eventData.userId),
      method: payload.creationMethod,
      sourceDocId: payload.parentDocumentId,
    };
  }

  return null;
}

// Extract annotation ID from event payload
export function getAnnotationIdFromEvent(event: StoredEvent): string | null {
  const eventData = event.event;

  switch (eventData.type) {
    case 'annotation.added': {
      const payload = eventData.payload as AnnotationAddedEvent['payload'];
      return payload.annotation.id;
    }
    case 'annotation.removed':
    case 'annotation.resolved': {
      const payload = eventData.payload as AnnotationRemovedEvent['payload'] | AnnotationResolvedEvent['payload'];
      return payload.annotationId;
    }

    default:
      return null;
  }
}

// Check if event relates to the hovered annotation
export function isEventRelatedToAnnotation(event: StoredEvent, annotationId: string): boolean {
  const eventAnnotationId = getAnnotationIdFromEvent(event);
  return eventAnnotationId === annotationId;
}
