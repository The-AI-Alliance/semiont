/**
 * Event Formatting Utilities
 *
 * Helper functions for displaying document events in the UI
 * Complete implementation with i18n support, ported from SDK
 */

import type { StoredEvent, DocumentEventType } from './event-utils';
import type { Annotation } from './types';
import { getExactText } from './selector-utils';
import { compareAnnotationIds } from './annotation-utils';

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/**
 * Format event type for display with i18n support
 */
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

/**
 * Get emoji for event type
 */
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
  references: Annotation[],
  _highlights: Annotation[], // underscore prefix to indicate intentionally unused
  allEvents: StoredEvent[]
): { exact: string; isQuoted: boolean; isTag: boolean } | null {
  const eventData = event.event;
  const payload = eventData.payload as any;

  // Use type discriminators instead of runtime typeof checks
  switch (eventData.type) {
    case 'document.created':
    case 'document.cloned': {
      return { exact: payload.name, isQuoted: false, isTag: false };
    }

    case 'reference.resolved': {
      // Handle both URI format and simple ID format
      const reference = references.find(r =>
        compareAnnotationIds(r.id, payload.referenceId)
      );

      if (reference?.target?.selector) {
        try {
          const exact = getExactText(reference.target.selector as any);
          if (exact) {
            return { exact: truncateText(exact), isQuoted: true, isTag: false };
          }
        } catch {
          // If selector parsing fails, continue to return null
        }
      }
      return null;
    }

    case 'highlight.removed': {
      // Find the original highlight.added event
      const addedEvent = allEvents.find(e =>
        e.event.type === 'highlight.added' &&
        (e.event.payload as any).highlightId === payload.highlightId
      );
      if (addedEvent) {
        const addedPayload = addedEvent.event.payload as any;
        return { exact: truncateText(addedPayload.exact), isQuoted: true, isTag: false };
      }
      return null;
    }

    case 'reference.deleted': {
      // Find the original reference.created event
      const createdEvent = allEvents.find(e =>
        e.event.type === 'reference.created' &&
        (e.event.payload as any).referenceId === payload.referenceId
      );
      if (createdEvent) {
        const createdPayload = createdEvent.event.payload as any;
        return { exact: truncateText(createdPayload.exact), isQuoted: true, isTag: false };
      }
      return null;
    }

    case 'highlight.added': {
      return { exact: truncateText(payload.exact), isQuoted: true, isTag: false };
    }

    case 'reference.created': {
      return { exact: truncateText(payload.exact), isQuoted: true, isTag: false };
    }

    case 'entitytag.added':
    case 'entitytag.removed': {
      return { exact: payload.entityType, isQuoted: false, isTag: true };
    }

    case 'assessment.added': {
      return { exact: truncateText(payload.exact), isQuoted: true, isTag: false };
    }

    case 'assessment.removed': {
      // Find the original assessment.added event
      const addedEvent = allEvents.find(e =>
        e.event.type === 'assessment.added' &&
        (e.event.payload as any).assessmentId === payload.assessmentId
      );
      if (addedEvent) {
        const addedPayload = addedEvent.event.payload as any;
        return { exact: truncateText(addedPayload.exact), isQuoted: true, isTag: false };
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

  if (eventData.type === 'reference.created') {
    const payload = eventData.payload as any;
    return payload.entityTypes ?? [];
  }

  return [];
}

/**
 * Document creation details
 */
export interface DocumentCreationDetails {
  type: 'created' | 'cloned';
  method: string;
  userId?: string;
  sourceDocId?: string; // For cloned documents
  parentDocumentId?: string;
  metadata?: Record<string, any>;
}

/**
 * Get document creation details from event
 */
export function getDocumentCreationDetails(event: StoredEvent): DocumentCreationDetails | null {
  const eventData = event.event;
  const payload = eventData.payload as any;

  if (eventData.type === 'document.created') {
    return {
      type: 'created',
      method: payload.creationMethod || 'unknown',
      userId: eventData.userId,
      metadata: payload.metadata,
    };
  }

  if (eventData.type === 'document.cloned') {
    return {
      type: 'cloned',
      method: payload.creationMethod || 'clone',
      userId: eventData.userId,
      sourceDocId: payload.parentDocumentId,
      parentDocumentId: payload.parentDocumentId,
      metadata: payload.metadata,
    };
  }

  return null;
}
