'use client';

import { useEffect, useRef } from 'react';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

interface HighlightEntryProps {
  highlight: Annotation;
  isFocused: boolean;
  onClick: () => void;
  onHighlightRef: (highlightId: string, el: HTMLElement | null) => void;
  onHighlightHover?: (highlightId: string | null) => void;
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

export function HighlightEntry({
  highlight,
  isFocused,
  onClick,
  onHighlightRef,
  onHighlightHover,
}: HighlightEntryProps) {
  const highlightRef = useRef<HTMLDivElement>(null);

  // Register ref with parent
  useEffect(() => {
    onHighlightRef(highlight.id, highlightRef.current);
    return () => {
      onHighlightRef(highlight.id, null);
    };
  }, [highlight.id, onHighlightRef]);

  // Scroll to highlight when focused
  useEffect(() => {
    if (isFocused && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isFocused]);

  const selectedText = getAnnotationExactText(highlight);

  return (
    <div
      ref={highlightRef}
      className="semiont-annotation-entry"
      data-type="highlight"
      data-focused={isFocused ? 'true' : 'false'}
      onClick={onClick}
      onMouseEnter={() => onHighlightHover?.(highlight.id)}
      onMouseLeave={() => onHighlightHover?.(null)}
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
}
