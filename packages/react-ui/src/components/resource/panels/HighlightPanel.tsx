'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import { useEvents } from '../../../contexts/EventBusContext';
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
  pendingAnnotation,
  isDetecting = false,
  detectionProgress,
  annotateMode = true,
}: HighlightPanelProps) {
  const t = useTranslations('HighlightPanel');
  const eventBus = useEvents();
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);

  const { sortedAnnotations, containerRef } =
    useAnnotationPanel(annotations);

  // Subscribe to click events - update focused state
  useEffect(() => {
    const handler = ({ annotationId }: { annotationId: string }) => {
      setFocusedAnnotationId(annotationId);
      setTimeout(() => setFocusedAnnotationId(null), 3000);
    };

    eventBus.on('annotation:click', handler);
    return () => eventBus.off('annotation:click', handler);
  }, [eventBus]);

  // Highlights auto-create: when pendingAnnotation arrives with highlighting motivation,
  // immediately emit annotation:create event
  useEffect(() => {
    if (pendingAnnotation && pendingAnnotation.motivation === 'highlighting') {
      eventBus.emit('annotation:create', {
        motivation: 'highlighting',
        selector: pendingAnnotation.selector,
        body: [],
      });
    }
  }, [pendingAnnotation, eventBus]);

  return (
    <div className="semiont-panel">
      <PanelHeader annotationType="highlight" count={annotations.length} title={t('title')} />

      {/* Scrollable content area */}
      <div ref={containerRef} className="semiont-panel__content">
        {/* Detection Section - only in Annotate mode and for text resources */}
        {annotateMode && (
          <DetectSection
            annotationType="highlight"
            isDetecting={isDetecting}
            detectionProgress={detectionProgress}
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
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
