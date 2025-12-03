'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { HighlightEntry } from './HighlightEntry';
import { useAnnotationPanel } from '@/hooks/useAnnotationPanel';
import { DetectSection } from './DetectSection';
import { PanelHeader } from './PanelHeader';

type Annotation = components['schemas']['Annotation'];

interface HighlightPanelProps {
  highlights: Annotation[];
  onHighlightClick: (annotation: Annotation) => void;
  focusedHighlightId: string | null;
  hoveredHighlightId?: string | null;
  onHighlightHover?: (highlightId: string | null) => void;
  resourceContent: string;
  onDetectHighlights?: (instructions?: string) => void | Promise<void>;
  isDetecting?: boolean;
  detectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
  } | null;
  annotateMode?: boolean;
}

export function HighlightPanel({
  highlights,
  onHighlightClick,
  focusedHighlightId,
  hoveredHighlightId,
  onHighlightHover,
  resourceContent,
  onDetectHighlights,
  isDetecting = false,
  detectionProgress,
  annotateMode = true,
}: HighlightPanelProps) {
  const t = useTranslations('HighlightPanel');

  const { sortedAnnotations: sortedHighlights, containerRef, handleAnnotationRef } =
    useAnnotationPanel(highlights, hoveredHighlightId);

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <PanelHeader annotationType="highlight" count={highlights.length} title={t('title')} />

      {/* Scrollable content area */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Detection Section - only in Annotate mode and for text resources */}
        {annotateMode && onDetectHighlights && (
          <DetectSection
            annotationType="highlight"
            isDetecting={isDetecting}
            detectionProgress={detectionProgress}
            onDetect={onDetectHighlights}
          />
        )}

        {/* Highlights list */}
        <div className="space-y-4">
          {sortedHighlights.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-sm">
              {t('noHighlights')}
            </p>
          ) : (
            sortedHighlights.map((highlight) => (
              <HighlightEntry
                key={highlight.id}
                highlight={highlight}
                isFocused={highlight.id === focusedHighlightId}
                onClick={() => onHighlightClick(highlight)}
                onHighlightRef={handleAnnotationRef}
                {...(onHighlightHover && { onHighlightHover })}
                resourceContent={resourceContent}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
