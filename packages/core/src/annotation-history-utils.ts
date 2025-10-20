/**
 * Utility functions for AnnotationHistory component
 * Extracted to reduce component complexity and improve testability
 */

import type {
  StoredEvent,
  DocumentEventType,
  DocumentCreatedEvent,
  DocumentClonedEvent,
  HighlightAddedEvent,
  HighlightRemovedEvent,
  ReferenceCreatedEvent,
  ReferenceResolvedEvent,
  ReferenceDeletedEvent,
  EntityTagAddedEvent,
  EntityTagRemovedEvent,
  AssessmentAddedEvent,
  AssessmentRemovedEvent,
} from './events';
import type { CreationMethod } from './creation-methods';
import type { components } from '@semiont/api-client';

// Import OpenAPI types
type Annotation = components['schemas']['Annotation'];
import { getExactText } from './selector-utils';
import { compareAnnotationIds } from './annotation-schemas';

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
    case 'highlight.added':
      return t('highlightAdded');
    case 'highlight.removed':
      return t('highlightRemoved');
    case 'reference.created':
      return t('referenceCreated');
    case 'reference.resolved':
      return t('referenceResolved');
    case 'reference.deleted':
      return t('referenceDeleted');
    case 'entitytag.added':
      return t('entitytagAdded');
    case 'entitytag.removed':
      return t('entitytagRemoved');
    case 'assessment.added':
      return t('assessmentAdded');
    case 'assessment.removed':
      return t('assessmentRemoved');
    default:
      // Exhaustive check: if we get here, we missed a case
      const _exhaustiveCheck: never = type;
      return _exhaustiveCheck;
  }
}

// Get emoji for event type
export function getEventEmoji(type: DocumentEventType): string {
  // Using a switch for exhaustive checking - TypeScript will error if we miss a case
  switch (type) {
    case 'document.created':
    case 'document.cloned':
    case 'document.archived':
    case 'document.unarchived':
      return '📄';
    case 'highlight.added':
      return '🟡';
    case 'highlight.removed':
      return '🗑️';
    case 'reference.created':
      return '🔵';
    case 'reference.resolved':
      return '🔗';
    case 'reference.deleted':
      return '🗑️';
    case 'entitytag.added':
    case 'entitytag.removed':
      return '🏷️';
    case 'assessment.added':
      return '🔴';
    case 'assessment.removed':
      return '🗑️';
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
  references: Annotation[],
  _highlights: Annotation[], // underscore prefix to indicate intentionally unused
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

    case 'reference.resolved': {
      const payload = eventData.payload as ReferenceResolvedEvent['payload'];

      // Handle both URI format (http://localhost:4000/annotations/ID) and simple ID format
      // The event payload may have just the ID, but annotations are stored with full URI
      const reference = references.find(r =>
        compareAnnotationIds(r.id, payload.referenceId)
      );

      if (reference?.target?.selector) {
        const exact = getExactText(reference.target.selector);
        if (exact) {
          return { exact: truncateText(exact), isQuoted: true, isTag: false };
        }
      }
      return null;
    }

    case 'highlight.removed': {
      const payload = eventData.payload as HighlightRemovedEvent['payload'];
      // Find the original highlight.added event
      const addedEvent = allEvents.find(e =>
        e.event.type === 'highlight.added' &&
        (e.event.payload as HighlightAddedEvent['payload']).highlightId === payload.highlightId
      );
      if (addedEvent) {
        const addedPayload = addedEvent.event.payload as HighlightAddedEvent['payload'];
        return { exact: truncateText(addedPayload.exact), isQuoted: true, isTag: false };
      }
      return null;
    }

    case 'reference.deleted': {
      const payload = eventData.payload as ReferenceDeletedEvent['payload'];
      // Find the original reference.created event
      const createdEvent = allEvents.find(e =>
        e.event.type === 'reference.created' &&
        (e.event.payload as ReferenceCreatedEvent['payload']).referenceId === payload.referenceId
      );
      if (createdEvent) {
        const createdPayload = createdEvent.event.payload as ReferenceCreatedEvent['payload'];
        return { exact: truncateText(createdPayload.exact), isQuoted: true, isTag: false };
      }
      return null;
    }

    case 'highlight.added': {
      const payload = eventData.payload as HighlightAddedEvent['payload'];
      return { exact: truncateText(payload.exact), isQuoted: true, isTag: false };
    }

    case 'reference.created': {
      const payload = eventData.payload as ReferenceCreatedEvent['payload'];
      return { exact: truncateText(payload.exact), isQuoted: true, isTag: false };
    }

    case 'entitytag.added':
    case 'entitytag.removed': {
      const payload = eventData.payload as EntityTagAddedEvent['payload'] | EntityTagRemovedEvent['payload'];
      return { exact: payload.entityType, isQuoted: false, isTag: true };
    }

    case 'assessment.added': {
      const payload = eventData.payload as AssessmentAddedEvent['payload'];
      return { exact: truncateText(payload.exact), isQuoted: true, isTag: false };
    }

    case 'assessment.removed': {
      const payload = eventData.payload as AssessmentRemovedEvent['payload'];
      // Find the original assessment.added event
      const addedEvent = allEvents.find(e =>
        e.event.type === 'assessment.added' &&
        (e.event.payload as AssessmentAddedEvent['payload']).assessmentId === payload.assessmentId
      );
      if (addedEvent) {
        const addedPayload = addedEvent.event.payload as AssessmentAddedEvent['payload'];
        return { exact: truncateText(addedPayload.exact), isQuoted: true, isTag: false };
      }
      return null;
    }

    default:
      return null;
  }
}

// Extract entity types from event payload
export function getEventEntityTypes(event: StoredEvent): string[] {
  const eventData = event.event;

  if (eventData.type === 'reference.created') {
    const payload = eventData.payload as ReferenceCreatedEvent['payload'];
    return payload.entityTypes ?? [];
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
    case 'highlight.added':
    case 'highlight.removed': {
      const payload = eventData.payload as HighlightAddedEvent['payload'] | HighlightRemovedEvent['payload'];
      return payload.highlightId;
    }

    case 'reference.created':
    case 'reference.resolved':
    case 'reference.deleted': {
      const payload = eventData.payload as ReferenceCreatedEvent['payload'] | ReferenceResolvedEvent['payload'] | ReferenceDeletedEvent['payload'];
      return payload.referenceId;
    }

    case 'assessment.added':
    case 'assessment.removed': {
      const payload = eventData.payload as AssessmentAddedEvent['payload'] | AssessmentRemovedEvent['payload'];
      return payload.assessmentId;
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
