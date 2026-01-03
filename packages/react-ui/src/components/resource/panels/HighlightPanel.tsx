'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { HighlightEntry } from './HighlightEntry';
import { useAnnotationPanel } from '../../../hooks/useAnnotationPanel';
import { DetectSection } from './DetectSection';
import { PanelHeader } from './PanelHeader';

type Annotation = components['schemas']['Annotation'];

interface HighlightPanelProps {
  annotations: Annotation[];
  onAnnotationClick: (annotation: Annotation) => void;
  focusedAnnotationId: string | null;
  hoveredAnnotationId?: string | null;
  onAnnotationHover?: (annotationId: string | null) => void;
  onDetect?: (instructions?: string) => void | Promise<void>;
  isDetecting?: boolean;
  detectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
  } | null;
  annotateMode?: boolean;
}

export function HighlightPanel({
  annotations,
  onAnnotationClick,
  focusedAnnotationId,
  hoveredAnnotationId,
  onAnnotationHover,
  onDetect,
  isDetecting = false,
  detectionProgress,
  annotateMode = true,
}: HighlightPanelProps) {
  const t = useTranslations('HighlightPanel');

  const { sortedAnnotations, containerRef, handleAnnotationRef } =
    useAnnotationPanel(annotations, hoveredAnnotationId);

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <PanelHeader annotationType="highlight" count={annotations.length} title={t('title')} />

      {/* Scrollable content area */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Detection Section - only in Annotate mode and for text resources */}
        {annotateMode && onDetect && (
          <DetectSection
            annotationType="highlight"
            isDetecting={isDetecting}
            detectionProgress={detectionProgress}
            onDetect={onDetect}
          />
        )}

        {/* Highlights list */}
        <div className="space-y-4">
          {sortedAnnotations.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-sm">
              {t('noHighlights')}
            </p>
          ) : (
            sortedAnnotations.map((highlight) => (
              <HighlightEntry
                key={highlight.id}
                highlight={highlight}
                isFocused={highlight.id === focusedAnnotationId}
                onClick={() => onAnnotationClick(highlight)}
                onHighlightRef={handleAnnotationRef}
                {...(onAnnotationHover && { onHighlightHover: onAnnotationHover })}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
