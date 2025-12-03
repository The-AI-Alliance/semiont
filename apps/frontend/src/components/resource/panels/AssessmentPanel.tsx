'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { AssessmentEntry } from './AssessmentEntry';
import { useAnnotationPanel } from '@/hooks/useAnnotationPanel';
import { DetectSection } from './DetectSection';
import { PanelHeader } from './PanelHeader';

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

  const { sortedAnnotations: sortedAssessments, containerRef, handleAnnotationRef } =
    useAnnotationPanel(assessments, hoveredAssessmentId);

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <PanelHeader annotationType="assessment" count={assessments.length} title={t('title')} />

      {/* Scrollable content area */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Detection Section - only in Annotate mode and for text resources */}
        {annotateMode && onDetectAssessments && (
          <DetectSection
            annotationType="assessment"
            isDetecting={isDetecting}
            detectionProgress={detectionProgress}
            onDetect={onDetectAssessments}
          />
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
                onAssessmentRef={handleAnnotationRef}
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
