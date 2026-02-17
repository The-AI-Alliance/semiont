'use client';

import { forwardRef } from 'react';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText } from '@semiont/api-client';
import { useEventBus } from '../../../contexts/EventBusContext';

type Annotation = components['schemas']['Annotation'];

interface HighlightEntryProps {
  highlight: Annotation;
  isFocused: boolean;
  isHovered?: boolean;
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;

  return date.toLocaleDateString();
}

export const HighlightEntry = forwardRef<HTMLDivElement, HighlightEntryProps>(
  function HighlightEntry(
    {
      highlight,
      isFocused,
      isHovered = false,
    },
    ref
  ) {
  const eventBus = useEventBus();

  const selectedText = getAnnotationExactText(highlight);

  return (
    <div
      ref={ref}
      className={`semiont-annotation-entry${isHovered ? ' semiont-annotation-pulse' : ''}`}
      data-type="highlight"
      data-focused={isFocused ? 'true' : 'false'}
      onClick={() => {
        eventBus.emit('annotation:click', { annotationId: highlight.id, motivation: highlight.motivation });
      }}
      onMouseEnter={() => {
        eventBus.emit('annotation:hover', { annotationId: highlight.id });
      }}
      onMouseLeave={() => {
        eventBus.emit('annotation:hover', { annotationId: null });
      }}
    >
      {/* Highlighted text */}
      {selectedText && (
        <div className="semiont-annotation-entry__quote" data-type="highlight">
          "{selectedText.substring(0, 200)}{selectedText.length > 200 ? '...' : ''}"
        </div>
      )}

      {/* Metadata */}
      <div className="semiont-annotation-entry__metadata">
        By {typeof highlight.creator === 'string' ? highlight.creator : highlight.creator?.name || 'Unknown'} • {formatRelativeTime(highlight.created || new Date().toISOString())}
      </div>
    </div>
  );
});
