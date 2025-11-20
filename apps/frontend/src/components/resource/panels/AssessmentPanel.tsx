'use client';

import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';
import { AssessmentEntry } from './AssessmentEntry';
import { ANNOTATION_TYPES } from '@/lib/annotation-registry';

type Annotation = components['schemas']['Annotation'];

interface AssessmentPanelProps {
  assessments: Annotation[];
  onAssessmentClick: (annotation: Annotation) => void;
  focusedAssessmentId: string | null;
  hoveredAssessmentId?: string | null;
  onAssessmentHover?: (assessmentId: string | null) => void;
  resourceContent: string;
  onDetectAssessments?: (instructions?: string) => void | Promise<void>;
  isDetecting?: boolean;
  detectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
  } | null;
  annotateMode?: boolean;
}

export function AssessmentPanel({
  assessments,
  onAssessmentClick,
  focusedAssessmentId,
  hoveredAssessmentId,
  onAssessmentHover,
  resourceContent,
  onDetectAssessments,
  isDetecting = false,
  detectionProgress,
  annotateMode = true,
}: AssessmentPanelProps) {
  const t = useTranslations('AssessmentPanel');
  const [instructions, setInstructions] = useState('');
  const assessmentRefs = useRef<Map<string, HTMLElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Sort assessments by their position in the resource
  const sortedAssessments = useMemo(() => {
    return [...assessments].sort((a, b) => {
      const aSelector = getTextPositionSelector(getTargetSelector(a.target));
      const bSelector = getTextPositionSelector(getTargetSelector(b.target));
      if (!aSelector || !bSelector) return 0;
      return aSelector.start - bSelector.start;
    });
  }, [assessments]);

  // Handle hoveredAssessmentId - scroll to and pulse assessment entry
  useEffect(() => {
    if (!hoveredAssessmentId) return;

    const assessmentElement = assessmentRefs.current.get(hoveredAssessmentId);

    if (assessmentElement && containerRef.current) {
      assessmentElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      assessmentElement.classList.add('bg-gray-200', 'dark:bg-gray-700');
      setTimeout(() => {
        assessmentElement.classList.remove('bg-gray-200', 'dark:bg-gray-700');
      }, 1500);
    }
  }, [hoveredAssessmentId]);

  const handleAssessmentRef = (assessmentId: string, el: HTMLElement | null) => {
    if (el) {
      assessmentRefs.current.set(assessmentId, el);
    } else {
      assessmentRefs.current.delete(assessmentId);
    }
  };

  const handleDetect = () => {
    if (onDetectAssessments) {
      onDetectAssessments(instructions.trim() || undefined);
      setInstructions('');
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {ANNOTATION_TYPES.assessment!.iconEmoji} {t('title')} ({assessments.length})
        </h2>
      </div>

      {/* Scrollable content area */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Detection Section - only in Annotate mode and for text resources */}
        {annotateMode && onDetectAssessments && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
              {t('detectAssessments')}
            </h3>
            <div className={`bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 ${
              isDetecting && detectionProgress ? 'border-2 border-red-500 dark:border-red-600' : ''
            }`}>
              {!isDetecting && !detectionProgress && (
                <>
                  <div className="mb-4">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
                      {t('instructions')} {t('optional')}
                    </label>
                    <textarea
                      value={instructions}
                      onChange={(e) => setInstructions(e.target.value)}
                      className="w-full p-2 border rounded text-sm dark:bg-gray-800 dark:border-gray-600"
                      rows={3}
                      placeholder={t('instructionsPlaceholder')}
                      maxLength={500}
                    />
                    <div className="text-xs text-gray-500 mt-1">
                      {instructions.length}/500
                    </div>
                  </div>

                  <button
                    onClick={handleDetect}
                    className="w-full px-4 py-2 rounded-lg transition-colors duration-200 font-medium bg-gradient-to-r from-red-600 to-pink-600 hover:from-red-700 hover:to-pink-700 text-white shadow-md hover:shadow-lg"
                  >
                    <span className="text-2xl">✨</span>
                  </button>
                </>
              )}

              {/* Detection Progress */}
              {isDetecting && detectionProgress && (
                <div className="space-y-3">
                  <div className="text-sm text-gray-600 dark:text-gray-400">
                    <div className="flex items-center gap-2">
                      <span className="text-lg animate-sparkle-infinite">✨</span>
                      <span>{detectionProgress.message}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Assessments list */}
        <div className="space-y-4">
          {sortedAssessments.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-sm">
              {t('noAssessments')}
            </p>
          ) : (
            sortedAssessments.map((assessment) => (
              <AssessmentEntry
                key={assessment.id}
                assessment={assessment}
                isFocused={assessment.id === focusedAssessmentId}
                onClick={() => onAssessmentClick(assessment)}
                onAssessmentRef={handleAssessmentRef}
                {...(onAssessmentHover && { onAssessmentHover })}
                resourceContent={resourceContent}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
