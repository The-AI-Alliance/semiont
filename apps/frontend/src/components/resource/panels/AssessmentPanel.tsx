'use client';

import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';
import { AssessmentEntry } from './AssessmentEntry';

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
}: AssessmentPanelProps) {
  const t = useTranslations('AssessmentPanel');
  const [showDetect, setShowDetect] = useState(false);
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
      setShowDetect(false);
      setInstructions('');
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            🎯 {t('title')} ({assessments.length})
          </h2>
          {onDetectAssessments && (
            <button
              onClick={() => setShowDetect(!showDetect)}
              className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
              title={t('detectAssessments')}
            >
              ✨
            </button>
          )}
        </div>
      </div>

      {/* Detect assessments UI */}
      {showDetect && onDetectAssessments && (
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-blue-50 dark:bg-blue-900/10">
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('instructions')} {t('optional')}
              </label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                className="w-full mt-1 p-2 border rounded text-sm dark:bg-gray-800 dark:border-gray-600"
                rows={2}
                placeholder={t('instructionsPlaceholder')}
                maxLength={500}
                disabled={isDetecting}
              />
              <div className="text-xs text-gray-500 mt-1">
                {instructions.length}/500
              </div>
            </div>

            {detectionProgress && (
              <div className="text-sm text-gray-600 dark:text-gray-400">
                <div className="flex items-center gap-2">
                  {detectionProgress.percentage !== undefined && (
                    <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                      <div
                        className="bg-blue-600 h-2 rounded-full transition-all"
                        style={{ width: `${detectionProgress.percentage}%` }}
                      />
                    </div>
                  )}
                  <span>{detectionProgress.message}</span>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleDetect}
                disabled={isDetecting}
                className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                {isDetecting ? t('detecting') : t('detect')}
              </button>
              <button
                onClick={() => setShowDetect(false)}
                disabled={isDetecting}
                className="px-3 py-1 border rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-sm disabled:opacity-50"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assessments list */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-4">
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
  );
}
