/**
 * Utility functions for AnnotationHistory component
 * Extracted to reduce component complexity and improve testability
 */

import type { StoredEvent } from '@semiont/core-types';

// Format event type for display
export function formatEventType(type: string): string {
  const typeMap: Record<string, string> = {
    'document.created': 'Created Document',
    'document.cloned': 'Cloned',
    'document.archived': 'Archived',
    'document.unarchived': 'Unarchived',
    'highlight.added': 'Highlight Added',
    'highlight.removed': 'Highlight Removed',
    'reference.created': 'Reference Created',
    'reference.resolved': 'Reference Resolved',
    'reference.deleted': 'Reference Deleted',
    'entitytag.added': 'Tag Added',
    'entitytag.removed': 'Tag Removed',
  };

  return typeMap[type] || type;
}

// Get emoji for event type
export function getEventEmoji(type: string): string {
  const emojiMap: Record<string, string> = {
    'document.created': '📄',
    'document.cloned': '📄',
    'document.archived': '📄',
    'document.unarchived': '📄',
    'highlight.added': '🟡',
    'highlight.removed': '🗑️',
    'reference.created': '🔵',
    'reference.resolved': '🔗',
    'reference.deleted': '🗑️',
    'entitytag.added': '🏷️',
    'entitytag.removed': '🗑️',
  };

  return emojiMap[type] || '📝';
}

// Format relative time
export function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

// Extract display content from event payload
export function getEventDisplayContent(
  event: StoredEvent,
  references: any[],
  highlights: any[],
  allEvents: StoredEvent[]
): { text: string; isQuoted: boolean; isTag: boolean } | null {
  const payload = event.event.payload as any;

  // For document creation/clone events, show the document name (not quoted)
  if ((event.event.type === 'document.created' || event.event.type === 'document.cloned') && 'name' in payload && typeof payload.name === 'string') {
    return { text: payload.name, isQuoted: false, isTag: false };
  }

  // For reference.resolved events, look up the reference text
  if (event.event.type === 'reference.resolved' && 'referenceId' in payload) {
    const reference = references.find((r: any) => r.id === payload.referenceId);
    if (reference?.text) {
      const maxLength = 50;
      const text = reference.text.trim();
      const displayText = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
      return { text: displayText, isQuoted: true, isTag: false };
    }
  }

  // For highlight.removed events, look up the text from the original highlight.added event
  if (event.event.type === 'highlight.removed' && 'highlightId' in payload) {
    const addedEvent = allEvents.find((e: StoredEvent) =>
      e.event.type === 'highlight.added' &&
      (e.event.payload as any).highlightId === payload.highlightId
    );
    if (addedEvent && (addedEvent.event.payload as any).text) {
      const maxLength = 50;
      const text = ((addedEvent.event.payload as any).text as string).trim();
      const displayText = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
      return { text: displayText, isQuoted: true, isTag: false };
    }
  }

  // For reference.deleted events, look up the text from the original reference.created event
  if (event.event.type === 'reference.deleted' && 'referenceId' in payload) {
    const createdEvent = allEvents.find((e: StoredEvent) =>
      e.event.type === 'reference.created' &&
      (e.event.payload as any).referenceId === payload.referenceId
    );
    if (createdEvent && (createdEvent.event.payload as any).text) {
      const maxLength = 50;
      const text = ((createdEvent.event.payload as any).text as string).trim();
      const displayText = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
      return { text: displayText, isQuoted: true, isTag: false };
    }
  }

  // For highlight and reference events, show the text (quoted)
  if ('text' in payload && typeof payload.text === 'string') {
    const maxLength = 50;
    const text = payload.text.trim();
    const displayText = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
    return { text: displayText, isQuoted: true, isTag: false };
  }

  // For entity tag events, show the tag (as tag style)
  if ('entityType' in payload && typeof payload.entityType === 'string') {
    return { text: payload.entityType, isQuoted: false, isTag: true };
  }

  return null;
}

// Extract entity types from event payload
export function getEventEntityTypes(event: StoredEvent): string[] | null {
  const payload = event.event.payload as any;

  // For reference events, show entity types if present
  if (event.event.type === 'reference.created' && 'entityTypes' in payload && Array.isArray(payload.entityTypes)) {
    return payload.entityTypes;
  }

  return null;
}

// Extract additional metadata for document creation events
export function getDocumentCreationDetails(event: StoredEvent): { method?: string; sourceDocId?: string; userId?: string } | null {
  if (event.event.type !== 'document.created' && event.event.type !== 'document.cloned') {
    return null;
  }

  const payload = event.event.payload as any;
  const metadata = payload.metadata || {};

  return {
    method: metadata.creationMethod,
    sourceDocId: event.event.type === 'document.cloned' ? payload.parentDocumentId : undefined,
    userId: event.event.userId,
  };
}

// Extract annotation ID from event payload
export function getAnnotationIdFromEvent(event: StoredEvent): string | null {
  const payload = event.event.payload as any;

  // Check for highlightId or referenceId in payload
  if ('highlightId' in payload && typeof payload.highlightId === 'string') {
    return payload.highlightId;
  }
  if ('referenceId' in payload && typeof payload.referenceId === 'string') {
    return payload.referenceId;
  }

  return null;
}

// Check if event relates to the hovered annotation
export function isEventRelatedToAnnotation(event: StoredEvent, annotationId: string): boolean {
  const eventAnnotationId = getAnnotationIdFromEvent(event);
  return eventAnnotationId === annotationId;
}
