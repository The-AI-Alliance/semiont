'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import { useEventBus } from '../../../contexts/EventBusContext';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';
import type { components, Selector } from '@semiont/api-client';
import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';
import { HighlightEntry } from './HighlightEntry';
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
  scrollToAnnotationId?: string | null;
  onScrollCompleted?: () => void;
  hoveredAnnotationId?: string | null;
}

export function HighlightPanel({
  annotations,
  pendingAnnotation,
  isDetecting = false,
  detectionProgress,
  annotateMode = true,
  scrollToAnnotationId,
  onScrollCompleted,
  hoveredAnnotationId,
}: HighlightPanelProps) {

  const t = useTranslations('HighlightPanel');
  const eventBus = useEventBus();
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Direct ref management
  const entryRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Sort annotations by their position in the resource
  const sortedAnnotations = useMemo(() => {
    return [...annotations].sort((a, b) => {
      const aSelector = getTextPositionSelector(getTargetSelector(a.target));
      const bSelector = getTextPositionSelector(getTargetSelector(b.target));
      if (!aSelector || !bSelector) return 0;
      return aSelector.start - bSelector.start;
    });
  }, [annotations]);

  // Ref callback for entry components
  const setEntryRef = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) {
      entryRefs.current.set(id, element);
    } else {
      entryRefs.current.delete(id);
    }
  }, []);

  // Handle scrollToAnnotationId (click scroll)
  useEffect(() => {
    if (!scrollToAnnotationId) return;
    const element = entryRefs.current.get(scrollToAnnotationId);
    if (element && containerRef.current) {
      const elementTop = element.offsetTop;
      const containerHeight = containerRef.current.clientHeight;
      const elementHeight = element.offsetHeight;
      const scrollTo = elementTop - (containerHeight / 2) + (elementHeight / 2);
      containerRef.current.scrollTo({ top: scrollTo, behavior: 'smooth' });
      element.classList.remove('semiont-annotation-pulse');
      void element.offsetWidth;
      element.classList.add('semiont-annotation-pulse');
      if (onScrollCompleted) onScrollCompleted();
    }
  }, [scrollToAnnotationId]);

  // Handle hoveredAnnotationId (hover scroll only - pulse is handled by isHovered prop)
  useEffect(() => {
    if (!hoveredAnnotationId) return;
    const element = entryRefs.current.get(hoveredAnnotationId);
    if (!element || !containerRef.current) return;

    const container = containerRef.current;
    const elementRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const isVisible = elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom;
    if (!isVisible) {
      const elementTop = element.offsetTop;
      const containerHeight = container.clientHeight;
      const elementHeight = element.offsetHeight;
      const scrollTo = elementTop - (containerHeight / 2) + (elementHeight / 2);
      container.scrollTo({ top: scrollTo, behavior: 'smooth' });
    }

    // Pulse effect is handled by isHovered prop on HighlightEntry
  }, [hoveredAnnotationId]);

  // Subscribe to click events - update focused state
  // Event handler for annotation clicks (extracted to avoid inline arrow function)
  const handleAnnotationClick = useCallback(({ annotationId }: { annotationId: string }) => {
    setFocusedAnnotationId(annotationId);
    setTimeout(() => setFocusedAnnotationId(null), 3000);
  }, []);

  useEventSubscriptions({
    'annotation:click': handleAnnotationClick,
  });

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
  }, [pendingAnnotation]);

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
                isHovered={highlight.id === hoveredAnnotationId}
                ref={(el) => setEntryRef(highlight.id, el)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
