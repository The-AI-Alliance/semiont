'use client';

import React, { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

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

function getAssessmentText(annotation: Annotation): string | null {
  if (!annotation.body) return null;

  // Handle TextualBody directly
  if (typeof annotation.body === 'object' && 'value' in annotation.body && 'type' in annotation.body && annotation.body.type === 'TextualBody') {
    return (annotation.body as any).value || null;
  }

  // Handle array of bodies
  if (Array.isArray(annotation.body) && annotation.body.length > 0) {
    const textBody = annotation.body.find((b: any) => b.type === 'TextualBody') as any;
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
  const t = useTranslations('AssessmentPanel');
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
      className={`border rounded-lg p-3 transition-all cursor-pointer ${
        isFocused
          ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20 animate-pulse-outline'
          : 'border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600'
      }`}
      onClick={onClick}
      onMouseEnter={() => onAssessmentHover?.(assessment.id)}
      onMouseLeave={() => onAssessmentHover?.(null)}
    >
      {/* Selected text quote */}
      {selectedText && (
        <div className="text-sm text-gray-600 dark:text-gray-400 italic mb-2 border-l-2 border-blue-300 pl-2">
          "{selectedText.substring(0, 100)}{selectedText.length > 100 ? '...' : ''}"
        </div>
      )}

      {/* Assessment body */}
      {assessmentText && (
        <div className="text-sm mb-2 bg-blue-50 dark:bg-blue-900/10 p-2 rounded border-l-2 border-blue-400">
          {assessmentText}
        </div>
      )}

      {/* Metadata */}
      <div className="text-xs text-gray-500">
        By {typeof assessment.creator === 'string' ? assessment.creator : assessment.creator?.name || 'Unknown'} • {formatRelativeTime(assessment.created || new Date().toISOString())}
      </div>
    </div>
  );
}
