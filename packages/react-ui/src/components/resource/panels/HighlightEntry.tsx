'use client';

import type { Ref } from 'react';
import type { components } from '@semiont/core';
import { annotationId as toAnnotationId } from '@semiont/core';
import { getAnnotationExactText } from '@semiont/api-client';
import { useSemiont } from '../../../session/SemiontProvider';
import { useObservable } from '../../../hooks/useObservable';
import { useHoverEmitter } from '../../../hooks/useHoverEmitter';

type Annotation = components['schemas']['Annotation'];

interface HighlightEntryProps {
  highlight: Annotation;
  isFocused: boolean;
  isHovered?: boolean;
  ref?: Ref<HTMLDivElement>;
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
  isHovered = false,
  ref,
}: HighlightEntryProps) {
  const session = useObservable(useSemiont().activeSession$);
  const hoverProps = useHoverEmitter(highlight.id);

  const selectedText = getAnnotationExactText(highlight);

  return (
    <div
      ref={ref}
      className={`semiont-annotation-entry${isHovered ? ' semiont-annotation-pulse' : ''}`}
      data-type="highlight"
      data-focused={isFocused ? 'true' : 'false'}
      onClick={() => {
        session?.client.browse.click(toAnnotationId(highlight.id), highlight.motivation);
      }}
      {...hoverProps}
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
      {highlight.generator && (
        <div className="semiont-annotation-entry__metadata">
          Via {typeof highlight.generator === 'string' ? highlight.generator : highlight.generator.name}
        </div>
      )}
    </div>
  );
}
