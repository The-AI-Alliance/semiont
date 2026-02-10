'use client';

import { useState } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { components, Selector } from '@semiont/api-client';
import { AssessmentEntry } from './AssessmentEntry';
import { useAnnotationPanel } from '../../../hooks/useAnnotationPanel';
import { DetectSection } from './DetectSection';
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
  onAnnotationClick: (annotation: Annotation) => void;
  focusedAnnotationId: string | null;
  hoveredAnnotationId?: string | null;
  onAnnotationHover?: (annotationId: string | null) => void;
  onCreate: (assessmentText: string) => void;
  pendingAnnotation: PendingAnnotation | null;
  onDetect?: (instructions?: string) => void | Promise<void>;
  isDetecting?: boolean;
  detectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
  } | null;
  annotateMode?: boolean;
}

export function AssessmentPanel({
  annotations,
  onAnnotationClick,
  focusedAnnotationId,
  hoveredAnnotationId,
  onAnnotationHover,
  onCreate,
  pendingAnnotation,
  onDetect,
  isDetecting = false,
  detectionProgress,
  annotateMode = true,
}: AssessmentPanelProps) {
  const t = useTranslations('AssessmentPanel');
  const [newAssessmentText, setNewAssessmentText] = useState('');

  const { sortedAnnotations, containerRef, handleAnnotationRef } =
    useAnnotationPanel(annotations, hoveredAnnotationId);

  const handleSaveNewAssessment = () => {
    if (newAssessmentText.trim()) {
      onCreate(newAssessmentText);
      setNewAssessmentText('');
    }
  };

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
            <button
              onClick={handleSaveNewAssessment}
              className="semiont-button semiont-button--primary"
              data-type="assessment"
            >
              {t('save')}
            </button>
          </div>
        </div>
      )}

      {/* Scrollable content area */}
      <div ref={containerRef} className="semiont-panel__content">
        {/* Detection Section - only in Annotate mode and for text resources */}
        {annotateMode && onDetect && (
          <DetectSection
            annotationType="assessment"
            isDetecting={isDetecting}
            detectionProgress={detectionProgress}
            onDetect={onDetect}
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
                onClick={() => onAnnotationClick(assessment)}
                onAssessmentRef={handleAnnotationRef}
                {...(onAnnotationHover && { onAssessmentHover: onAnnotationHover })}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
