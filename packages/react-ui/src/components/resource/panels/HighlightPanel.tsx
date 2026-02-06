'use client';

import { useEffect } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { components, Selector } from '@semiont/api-client';
import { HighlightEntry } from './HighlightEntry';
import { useAnnotationPanel } from '../../../hooks/useAnnotationPanel';
import { DetectSection } from './DetectSection';
import { PanelHeader } from './PanelHeader';
import './HighlightPanel.css';

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];

// Unified pending annotation type
interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

interface HighlightPanelProps {
  annotations: Annotation[];
  onAnnotationClick: (annotation: Annotation) => void;
  focusedAnnotationId: string | null;
  hoveredAnnotationId?: string | null;
  onAnnotationHover?: (annotationId: string | null) => void;
  onDetect?: (instructions?: string) => void | Promise<void>;
  onCreate: (selector: Selector | Selector[]) => void;
  pendingAnnotation: PendingAnnotation | null;
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
  onCreate,
  pendingAnnotation,
  isDetecting = false,
  detectionProgress,
  annotateMode = true,
}: HighlightPanelProps) {
  const t = useTranslations('HighlightPanel');

  const { sortedAnnotations, containerRef, handleAnnotationRef } =
    useAnnotationPanel(annotations, hoveredAnnotationId);

  // Highlights auto-create: when pendingAnnotation arrives with highlighting motivation,
  // immediately call onCreate without showing a form
  useEffect(() => {
    if (pendingAnnotation && pendingAnnotation.motivation === 'highlighting') {
      onCreate(pendingAnnotation.selector);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAnnotation]); // Only depend on pendingAnnotation, not onCreate (which is recreated on every render)

  return (
    <div className="semiont-panel">
      <PanelHeader annotationType="highlight" count={annotations.length} title={t('title')} />

      {/* Scrollable content area */}
      <div ref={containerRef} className="semiont-panel__content">
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
        <div className="semiont-panel__list">
          {sortedAnnotations.length === 0 ? (
            <p className="semiont-panel__empty">
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
