'use client';

import React, { useMemo } from 'react';
import { api } from '@/lib/api-client';
import type { StoredEvent } from '@semiont/core-types';

interface Props {
  documentId: string;
  hoveredAnnotationId?: string | null;
  onEventHover?: (annotationId: string | null) => void;
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

// Extract text snippet from event payload
function getEventTextSnippet(event: StoredEvent): string | null {
  const payload = event.event.payload as any;

  // For highlight and reference events, show the text
  if ('text' in payload && typeof payload.text === 'string') {
    const maxLength = 50;
    const text = payload.text.trim();
    if (text.length > maxLength) {
      return text.substring(0, maxLength) + '...';
    }
    return text;
  }

  // For entity tag events, show the tag
  if ('entityType' in payload && typeof payload.entityType === 'string') {
    return payload.entityType;
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

  console.log('[AnnotationHistory] Document creation event payload:', {
    eventType: event.event.type,
    payload,
    metadata,
    creationMethod: metadata.creationMethod,
  });

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

export function AnnotationHistory({ documentId, hoveredAnnotationId, onEventHover }: Props) {
  // Load events using React Query
  // React Query will automatically refetch when the query is invalidated by the parent
  const { data: eventsData, isLoading: loading, isError: error } = api.documents.getEvents.useQuery(documentId);

  // Sort events by most recent first
  const events = useMemo(() => {
    if (!eventsData?.events) return [];
    return [...eventsData.events].sort((a: StoredEvent, b: StoredEvent) =>
      b.metadata.sequenceNumber - a.metadata.sequenceNumber
    );
  }, [eventsData]);

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
      <div className="space-y-2 max-h-[1200px] overflow-y-auto">
        {events.map((stored) => {
          const textSnippet = getEventTextSnippet(stored);
          const annotationId = getAnnotationIdFromEvent(stored);
          const creationDetails = getDocumentCreationDetails(stored);
          const isRelated = hoveredAnnotationId ? isEventRelatedToAnnotation(stored, hoveredAnnotationId) : false;
          const borderClass = isRelated
            ? 'border-l-4 border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/20'
            : 'border-l-2 border-gray-200 dark:border-gray-700';

          return (
            <div
              key={stored.event.id}
              className={`text-sm ${borderClass} pl-3 py-1 transition-all duration-200 ${annotationId ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/30' : ''}`}
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
              <div className="flex items-center gap-2">
                <span className="text-base">{getEventEmoji(stored.event.type)}</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {formatEventType(stored.event.type)}
                </span>
              </div>
              {textSnippet && (
                <div className="text-xs text-gray-600 dark:text-gray-400 mt-1 italic">
                  &ldquo;{textSnippet}&rdquo;
                </div>
              )}
              {creationDetails && (
                <div className="text-xs text-gray-600 dark:text-gray-400 mt-1 space-y-0.5">
                  {creationDetails.userId && (
                    <div>
                      <span className="text-gray-500 dark:text-gray-500">User:</span>{' '}
                      <span className="font-mono text-[10px]">{creationDetails.userId}</span>
                    </div>
                  )}
                  {creationDetails.method && (
                    <div>
                      <span className="text-gray-500 dark:text-gray-500">Method:</span>{' '}
                      <span className="capitalize">{creationDetails.method}</span>
                    </div>
                  )}
                  {creationDetails.sourceDocId && (
                    <div>
                      <span className="text-gray-500 dark:text-gray-500">Cloned from:</span>{' '}
                      <a
                        href={`/know/document/${encodeURIComponent(creationDetails.sourceDocId)}`}
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        View original
                      </a>
                    </div>
                  )}
                </div>
              )}
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {formatRelativeTime(stored.event.timestamp)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}