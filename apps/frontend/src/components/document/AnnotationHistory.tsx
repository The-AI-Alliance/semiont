'use client';

import React, { useMemo, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import type { StoredEvent } from '@semiont/core-types';

interface Props {
  documentId: string;
  hoveredAnnotationId?: string | null;
  onEventHover?: (annotationId: string | null) => void;
  onEventClick?: (annotationId: string | null) => void;
}

// Format event type for display
function formatEventType(type: string): string {
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
function getEventEmoji(type: string): string {
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
function formatRelativeTime(timestamp: string): string {
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
function getEventDisplayContent(event: StoredEvent, references: any[], highlights: any[], allEvents: StoredEvent[]): { text: string; isQuoted: boolean; isTag: boolean } | null {
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
function getEventEntityTypes(event: StoredEvent): string[] | null {
  const payload = event.event.payload as any;

  // For reference events, show entity types if present
  if (event.event.type === 'reference.created' && 'entityTypes' in payload && Array.isArray(payload.entityTypes)) {
    return payload.entityTypes;
  }

  return null;
}

// Extract additional metadata for document creation events
function getDocumentCreationDetails(event: StoredEvent): { method?: string; sourceDocId?: string; userId?: string } | null {
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
function getAnnotationIdFromEvent(event: StoredEvent): string | null {
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
function isEventRelatedToAnnotation(event: StoredEvent, annotationId: string): boolean {
  const eventAnnotationId = getAnnotationIdFromEvent(event);
  return eventAnnotationId === annotationId;
}

export function AnnotationHistory({ documentId, hoveredAnnotationId, onEventHover, onEventClick }: Props) {
  // Load events using React Query
  // React Query will automatically refetch when the query is invalidated by the parent
  const { data: eventsData, isLoading: loading, isError: error } = api.documents.getEvents.useQuery(documentId);

  // Load annotations to look up text for removed/resolved events
  const { data: referencesData } = api.selections.getReferences.useQuery(documentId);
  const { data: highlightsData } = api.selections.getHighlights.useQuery(documentId);
  const references = referencesData?.references || [];
  const highlights = highlightsData?.highlights || [];

  // Refs to track event elements for scrolling
  const eventRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Sort events by most recent first
  const events = useMemo(() => {
    if (!eventsData?.events) return [];
    return [...eventsData.events].sort((a: StoredEvent, b: StoredEvent) =>
      b.metadata.sequenceNumber - a.metadata.sequenceNumber
    );
  }, [eventsData]);

  // Scroll to hovered annotation's event when hoveredAnnotationId changes
  useEffect(() => {
    if (!hoveredAnnotationId) return;

    const eventElement = eventRefs.current.get(hoveredAnnotationId);

    if (eventElement) {
      eventElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
      // Also add a visual pulse to the history event
      eventElement.classList.add('bg-blue-100', 'dark:bg-blue-900/30');
      setTimeout(() => {
        eventElement.classList.remove('bg-blue-100', 'dark:bg-blue-900/30');
      }, 1500);
    }
  }, [hoveredAnnotationId]);

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          History
        </h3>
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return null; // Silently fail
  }

  if (events.length === 0) {
    return null; // No history to show
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
        History
      </h3>
      <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
        {events.map((stored) => {
          const displayContent = getEventDisplayContent(stored, references, highlights, events);
          const annotationId = getAnnotationIdFromEvent(stored);
          const creationDetails = getDocumentCreationDetails(stored);
          const entityTypes = getEventEntityTypes(stored);
          const isRelated = hoveredAnnotationId ? isEventRelatedToAnnotation(stored, hoveredAnnotationId) : false;
          const borderClass = isRelated
            ? 'border-l-4 border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/20'
            : 'border-l-2 border-gray-200 dark:border-gray-700';

          return (
            <div
              key={stored.event.id}
              ref={(el) => {
                if (el && annotationId) {
                  eventRefs.current.set(annotationId, el);
                } else if (!el && annotationId) {
                  eventRefs.current.delete(annotationId);
                }
              }}
              className={`text-xs ${borderClass} pl-2 py-0.5 transition-all duration-200 ${annotationId ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/30' : ''}`}
              onClick={() => {
                if (annotationId && onEventClick) {
                  onEventClick(annotationId);
                }
              }}
              onMouseEnter={() => {
                if (annotationId && onEventHover) {
                  onEventHover(annotationId);
                }
              }}
              onMouseLeave={() => {
                if (annotationId && onEventHover) {
                  onEventHover(null);
                }
              }}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-sm">{getEventEmoji(stored.event.type)}</span>
                {displayContent ? (
                  displayContent.isTag ? (
                    <span className="inline-flex items-center px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded text-[11px] font-medium">
                      {displayContent.text}
                    </span>
                  ) : displayContent.isQuoted ? (
                    <span className="font-medium text-gray-900 dark:text-gray-100 line-clamp-1 italic">
                      &ldquo;{displayContent.text}&rdquo;
                    </span>
                  ) : (
                    <span className="font-medium text-gray-900 dark:text-gray-100 line-clamp-1">
                      {displayContent.text}
                    </span>
                  )
                ) : (
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {formatEventType(stored.event.type)}
                  </span>
                )}
                <span className="text-[10px] text-gray-500 dark:text-gray-400 ml-auto">
                  {formatRelativeTime(stored.event.timestamp)}
                </span>
              </div>
              {entityTypes && entityTypes.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {entityTypes.map((type) => (
                    <span
                      key={type}
                      className="inline-flex items-center px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded text-[10px]"
                    >
                      {type}
                    </span>
                  ))}
                </div>
              )}
              {creationDetails && (
                <div className="text-[10px] text-gray-600 dark:text-gray-400 mt-0.5">
                  {creationDetails.userId && (
                    <span className="mr-2">
                      User: <span className="font-mono">{creationDetails.userId.substring(0, 8)}</span>
                    </span>
                  )}
                  {creationDetails.method && (
                    <span className="mr-2">
                      Method: <span className="capitalize">{creationDetails.method}</span>
                    </span>
                  )}
                  {creationDetails.sourceDocId && (
                    <a
                      href={`/know/document/${encodeURIComponent(creationDetails.sourceDocId)}`}
                      className="text-blue-600 dark:text-blue-400 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      View original
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}