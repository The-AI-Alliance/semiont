'use client';

import { useEffect, useRef } from 'react';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText } from '@semiont/api-client';
import { useMakeMeaningEvents } from '../../../contexts/MakeMeaningEventBusContext';

type Annotation = components['schemas']['Annotation'];

// W3C Annotation TextualBody type
interface TextualBody {
  type: 'TextualBody';
  value: string;
  format?: string;
  language?: string;
}

interface AssessmentEntryProps {
  assessment: Annotation;
  isFocused: boolean;
  onClick: () => void;
  onAssessmentRef: (assessmentId: string, el: HTMLElement | null) => void;
  onAssessmentHover?: (assessmentId: string | null) => void;
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

function isTextualBody(body: unknown): body is TextualBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    'type' in body &&
    body.type === 'TextualBody' &&
    'value' in body &&
    typeof body.value === 'string'
  );
}

function getAssessmentText(annotation: Annotation): string | null {
  if (!annotation.body) return null;

  // Handle TextualBody directly
  if (isTextualBody(annotation.body)) {
    return annotation.body.value || null;
  }

  // Handle array of bodies
  if (Array.isArray(annotation.body) && annotation.body.length > 0) {
    const textBody = annotation.body.find(isTextualBody);
    return textBody?.value || null;
  }

  return null;
}

export function AssessmentEntry({
  assessment,
  isFocused,
  onClick,
  onAssessmentRef,
  onAssessmentHover,
}: AssessmentEntryProps) {
  const eventBus = useMakeMeaningEvents();
  const assessmentRef = useRef<HTMLDivElement>(null);

  // Register ref with parent
  useEffect(() => {
    onAssessmentRef(assessment.id, assessmentRef.current);
    return () => {
      onAssessmentRef(assessment.id, null);
    };
  }, [assessment.id, onAssessmentRef]);

  // Scroll to assessment when focused
  useEffect(() => {
    if (isFocused && assessmentRef.current) {
      assessmentRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isFocused]);

  const selectedText = getAnnotationExactText(assessment);
  const assessmentText = getAssessmentText(assessment);

  return (
    <div
      ref={assessmentRef}
      className="semiont-annotation-entry"
      data-type="assessment"
      data-focused={isFocused ? 'true' : 'false'}
      onClick={onClick}
      onMouseEnter={() => {
        eventBus.emit('ui:annotation:hover', { annotationId: assessment.id });
        onAssessmentHover?.(assessment.id); // Backward compat
      }}
      onMouseLeave={() => {
        eventBus.emit('ui:annotation:hover', { annotationId: null });
        onAssessmentHover?.(null); // Backward compat
      }}
    >
      {/* Selected text quote */}
      {selectedText && (
        <div className="semiont-annotation-entry__quote" data-type="assessment">
          "{selectedText.substring(0, 100)}{selectedText.length > 100 ? '...' : ''}"
        </div>
      )}

      {/* Assessment body */}
      {assessmentText && (
        <div className="semiont-annotation-entry__body" data-type="assessment">
          {assessmentText}
        </div>
      )}

      {/* Metadata */}
      <div className="semiont-annotation-entry__metadata">
        By {typeof assessment.creator === 'string' ? assessment.creator : assessment.creator?.name || 'Unknown'} • {formatRelativeTime(assessment.created || new Date().toISOString())}
      </div>
    </div>
  );
}
