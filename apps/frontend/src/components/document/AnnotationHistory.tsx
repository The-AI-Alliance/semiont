'use client';

import React, { useEffect, useState } from 'react';
import { apiService } from '@/lib/api-client';
import type { StoredEvent } from '@semiont/core-types';

interface Props {
  documentId: string;
}

// Format event type for display
function formatEventType(type: string): string {
  const typeMap: Record<string, string> = {
    'document.created': 'Created',
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
  if (type.startsWith('document.')) return '📄';
  if (type.includes('highlight')) return '✨';
  if (type.includes('reference')) return '🔗';
  if (type.includes('entitytag')) return '🏷️';
  return '📝';
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

export function AnnotationHistory({ documentId }: Props) {
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadEvents() {
      try {
        setLoading(true);
        setError(null);
        const response = await apiService.documents.getEvents(documentId);
        // Sort by most recent first
        const sortedEvents = response.events.sort((a: StoredEvent, b: StoredEvent) =>
          b.metadata.sequenceNumber - a.metadata.sequenceNumber
        );
        setEvents(sortedEvents);
      } catch (err) {
        console.error('Failed to load annotation history:', err);
        setError('Failed to load history');
      } finally {
        setLoading(false);
      }
    }

    loadEvents();
  }, [documentId]);

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          Annotation History
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
        Annotation History
      </h3>
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {events.map((stored) => (
          <div
            key={stored.event.id}
            className="text-sm border-l-2 border-gray-200 dark:border-gray-700 pl-3 py-1"
          >
            <div className="flex items-center gap-2">
              <span className="text-base">{getEventEmoji(stored.event.type)}</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {formatEventType(stored.event.type)}
              </span>
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {formatRelativeTime(stored.event.timestamp)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}