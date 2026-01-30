/**
 * Utility functions for AnnotationHistory component
 * Extracted to reduce component complexity and improve testability
 *
 * NOTE: This file contains UI-specific logic and should eventually move to the frontend package.
 * It has been updated to work with unified annotation events (annotation.added/removed/body.updated)
 * instead of separate highlight/reference/assessment events.
 */

import type {
  StoredEvent,
  ResourceEventType,
  ResourceCreatedEvent,
  ResourceClonedEvent,
  AnnotationAddedEvent,
  AnnotationRemovedEvent,
  AnnotationBodyUpdatedEvent,
  EntityTagAddedEvent,
  EntityTagRemovedEvent,
} from './events';
import type { CreationMethod } from './creation-methods';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/ontology';
import type { AnnotationId } from './identifiers';

// Import OpenAPI types
type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

// Format event type for display
export function formatEventType(type: ResourceEventType, t: TranslateFn): string {
  // Using a switch for exhaustive checking - TypeScript will error if we miss a case
  switch (type) {
    case 'resource.created':
      return t('resourceCreated');
    case 'resource.cloned':
      return t('resourceCloned');
    case 'resource.archived':
      return t('resourceArchived');
    case 'resource.unarchived':
      return t('resourceUnarchived');
    case 'representation.added':
      return t('representationAdded');
    case 'representation.removed':
      return t('representationRemoved');
    case 'annotation.added':
      return t('annotationAdded');
    case 'annotation.removed':
      return t('annotationRemoved');
    case 'annotation.body.updated':
      return t('annotationBodyUpdated');
    case 'entitytag.added':
      return t('entitytagAdded');
    case 'entitytag.removed':
      return t('entitytagRemoved');
    case 'entitytype.added':
      return t('entitytypeAdded');
    case 'job.started':
      return t('jobStarted');
    case 'job.progress':
      return t('jobProgress');
    case 'job.completed':
      return t('jobCompleted');
    case 'job.failed':
      return t('jobFailed');
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
export function getEventEmoji(type: ResourceEventType, event?: StoredEvent): string {
  // Using a switch for exhaustive checking - TypeScript will error if we miss a case
  switch (type) {
    case 'resource.created':
    case 'resource.cloned':
    case 'resource.archived':
    case 'resource.unarchived':
      return '📄';
    case 'representation.added':
      return '📎';  // Paperclip for attachment/file
    case 'representation.removed':
      return '🗑️';  // Trash can for removal
    case 'annotation.added':
      if (event) {
        const payload = event.event.payload as AnnotationAddedEvent['payload'];
        return getMotivationEmoji(payload.annotation.motivation);
      }
      return '📝';
    case 'annotation.removed':
      return '🗑️';
    case 'annotation.body.updated':
      return '✏️';
    case 'entitytag.added':
    case 'entitytag.removed':
      return '🏷️';
    case 'entitytype.added':
      return '🏷️';  // Same emoji as entitytag (global entity type collection)
    case 'job.started':
      return '▶️';
    case 'job.progress':
      return '⏳';
    case 'job.completed':
      return '✅';
    case 'job.failed':
      return '❌';
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
    case 'resource.created':
    case 'resource.cloned': {
      const payload = eventData.payload as ResourceCreatedEvent['payload'] | ResourceClonedEvent['payload'];
      return { exact: payload.name, isQuoted: false, isTag: false };
    }

    case 'annotation.body.updated': {
      const payload = eventData.payload as AnnotationBodyUpdatedEvent['payload'];

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
    // Extract entity types from W3C annotation
    return getEntityTypes(payload.annotation);
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

// Resource creation details - discriminated by event type
type ResourceCreatedDetails = {
  type: 'created';
  userId: string;
  method: CreationMethod;
};

type ResourceClonedDetails = {
  type: 'cloned';
  userId: string;
  method: CreationMethod;
  sourceDocId: string;
};

export type ResourceCreationDetails = ResourceCreatedDetails | ResourceClonedDetails;

// Extract additional metadata for resource creation events
export function getResourceCreationDetails(event: StoredEvent): ResourceCreationDetails | null {
  const eventData = event.event;

  if (eventData.type === 'resource.created') {
    const payload = eventData.payload as ResourceCreatedEvent['payload'];

    return {
      type: 'created',
      userId: formatUserId(eventData.userId),
      method: payload.creationMethod,
    };
  }

  if (eventData.type === 'resource.cloned') {
    const payload = eventData.payload as ResourceClonedEvent['payload'];

    return {
      type: 'cloned',
      userId: formatUserId(eventData.userId),
      method: payload.creationMethod,
      sourceDocId: payload.parentResourceId,
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
    case 'annotation.body.updated': {
      const payload = eventData.payload as AnnotationRemovedEvent['payload'] | AnnotationBodyUpdatedEvent['payload'];
      return payload.annotationId;
    }

    default:
      return null;
  }
}

// Check if event relates to the hovered annotation
export function isEventRelatedToAnnotation(event: StoredEvent, annotationId: AnnotationId): boolean {
  const eventAnnotationId = getAnnotationIdFromEvent(event);
  return eventAnnotationId === annotationId;
}
