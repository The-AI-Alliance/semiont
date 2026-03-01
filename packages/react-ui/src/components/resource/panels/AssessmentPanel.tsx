'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import { useEventBus } from '../../../contexts/EventBusContext';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';
import type { components, Selector } from '@semiont/core';
import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';
import { AssessmentEntry } from './AssessmentEntry';
import { AssistSection } from './AssistSection';
import { PanelHeader } from './PanelHeader';
import './AssessmentPanel.css';

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];

// Unified pending annotation type
interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

// Helper to extract display text from selector
function getSelectorDisplayText(selector: Selector | Selector[]): string | null {
  if (Array.isArray(selector)) {
    // Text selectors: array of [TextPositionSelector, TextQuoteSelector]
    const quoteSelector = selector.find(s => s.type === 'TextQuoteSelector');
    if (quoteSelector && 'exact' in quoteSelector) {
      return quoteSelector.exact;
    }
  } else {
    // Single selector
    if (selector.type === 'TextQuoteSelector' && 'exact' in selector) {
      return selector.exact;
    }
  }
  return null;
}

interface AssessmentPanelProps {
  annotations: Annotation[];
  pendingAnnotation: PendingAnnotation | null;
  isAssisting?: boolean;
  progress?: {
    status: string;
    percentage?: number;
    message?: string;
  } | null;
  annotateMode?: boolean;
  scrollToAnnotationId?: string | null;
  onScrollCompleted?: () => void;
  hoveredAnnotationId?: string | null;
}

/**
 * Panel for managing assessment annotations with text input
 *
 * @emits annotate:create - Create new assessment annotation. Payload: { motivation: 'assessing', selector: Selector | Selector[], body: Body[] }
 * @emits annotate:cancel-pending - Cancel pending assessment annotation. Payload: undefined
 * @subscribes navigation:click - Annotation clicked. Payload: { annotationId: string }
 */
export function AssessmentPanel({
  annotations,
  pendingAnnotation,
  isAssisting = false,
  progress,
  annotateMode = true,
  scrollToAnnotationId,
  onScrollCompleted,
  hoveredAnnotationId,
}: AssessmentPanelProps) {
  const t = useTranslations('AssessmentPanel');
  const eventBus = useEventBus();
  const [newAssessmentText, setNewAssessmentText] = useState('');
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

    // Pulse effect is handled by isHovered prop on AssessmentEntry
  }, [hoveredAnnotationId]);

  const handleSaveNewAssessment = () => {
    if (pendingAnnotation) {
      const body: components['schemas']['AnnotationBody'][] = newAssessmentText.trim()
        ? [{ type: 'TextualBody' as const, value: newAssessmentText, purpose: 'assessing' as const }]
        : [];

      eventBus.get('annotate:create').next({
        motivation: 'assessing',
        selector: pendingAnnotation.selector,
        body,
      });
      setNewAssessmentText('');
    }
  };

  // Escape key handler for cancelling pending annotation
  useEffect(() => {
    if (!pendingAnnotation) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        eventBus.get('annotate:cancel-pending').next(undefined);
        setNewAssessmentText('');
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [pendingAnnotation]);

  // Event handler for annotation clicks (extracted to avoid inline arrow function)
  const handleAnnotationClick = useCallback(({ annotationId }: { annotationId: string }) => {
    setFocusedAnnotationId(annotationId);
    setTimeout(() => setFocusedAnnotationId(null), 3000);
  }, []);

  // Subscribe to click events - update focused state
  useEventSubscriptions({
    'navigation:click': handleAnnotationClick,
  });

  return (
    <div className="semiont-panel">
      <PanelHeader annotationType="assessment" count={annotations.length} title={t('title')} />

      {/* New assessment input - shown when there's a pending annotation with assessing motivation */}
      {pendingAnnotation && pendingAnnotation.motivation === 'assessing' && (
        <div className="semiont-annotation-prompt" data-type="assessment">
          <div className="semiont-annotation-prompt__quote">
            {(() => {
              const displayText = getSelectorDisplayText(pendingAnnotation.selector);
              if (displayText) {
                return `"${displayText.substring(0, 100)}${displayText.length > 100 ? '...' : ''}"`;
              }
              // Generic labels for PDF/image annotations without text
              return t('fragmentSelected');
            })()}
          </div>
          <textarea
            value={newAssessmentText}
            onChange={(e) => setNewAssessmentText(e.target.value)}
            className="semiont-textarea"
            rows={3}
            placeholder={t('assessmentPlaceholder')}
            autoFocus
            maxLength={2000}
          />
          <div className="semiont-annotation-prompt__footer">
            <span className="semiont-annotation-prompt__char-count">
              {newAssessmentText.length}/2000
            </span>
            <div className="semiont-annotation-prompt__actions">
              <button
                onClick={() => {
                  eventBus.get('annotate:cancel-pending').next(undefined);
                  setNewAssessmentText('');
                }}
                className="semiont-button semiont-button--secondary"
                data-type="assessment"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleSaveNewAssessment}
                className="semiont-button semiont-button--primary"
                data-type="assessment"
              >
                {t('save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scrollable content area */}
      <div ref={containerRef} className="semiont-panel__content">
        {/* Assist Section - only in Annotate mode and for text resources */}
        {annotateMode && (
          <AssistSection
            annotationType="assessment"
            isAssisting={isAssisting}
            progress={progress}
          />
        )}

        {/* Assessments list */}
        <div className="semiont-panel__list">
          {sortedAnnotations.length === 0 ? (
            <p className="semiont-panel__empty">
              {t('noAssessments')}
            </p>
          ) : (
            sortedAnnotations.map((assessment) => (
              <AssessmentEntry
                key={assessment.id}
                assessment={assessment}
                isFocused={assessment.id === focusedAnnotationId}
                isHovered={assessment.id === hoveredAnnotationId}
                ref={(el) => setEntryRef(assessment.id, el)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
