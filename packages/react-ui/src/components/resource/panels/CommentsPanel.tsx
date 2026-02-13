'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import { useEventBus } from '../../../contexts/EventBusContext';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';
import type { components, Selector } from '@semiont/api-client';
import { CommentEntry } from './CommentEntry';
import { useAnnotationPanel } from '../../../hooks/useAnnotationPanel';
import { DetectSection } from './DetectSection';
import { PanelHeader } from './PanelHeader';
import './CommentsPanel.css';

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

interface CommentsPanelProps {
  annotations: Annotation[];
  pendingAnnotation: PendingAnnotation | null;
  annotateMode?: boolean;
  isDetecting?: boolean;
  detectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
  } | null;
}

export function CommentsPanel({
  annotations,
  pendingAnnotation,
  annotateMode = true,
  isDetecting = false,
  detectionProgress,
}: CommentsPanelProps) {
  const t = useTranslations('CommentsPanel');
  const eventBus = useEventBus();
  const [newCommentText, setNewCommentText] = useState('');
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { sortedAnnotations } = useAnnotationPanel(annotations, containerRef);

  // Subscribe to click events - update focused state
  // Event handler for annotation clicks (extracted to avoid inline arrow function)
  const handleAnnotationClick = useCallback(({ annotationId }: { annotationId: string }) => {
    setFocusedAnnotationId(annotationId);
    setTimeout(() => setFocusedAnnotationId(null), 3000);
  }, []);

  useEventSubscriptions({
    'annotation:click': handleAnnotationClick,
  });

  const handleSaveNewComment = () => {
    if (newCommentText.trim() && pendingAnnotation) {
      eventBus.emit('annotation:create', {
        motivation: 'commenting',
        selector: pendingAnnotation.selector,
        body: [{ type: 'TextualBody', value: newCommentText, purpose: 'commenting' }],
      });
      setNewCommentText('');
    }
  };

  // Escape key handler for cancelling pending annotation
  useEffect(() => {
    if (!pendingAnnotation) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        eventBus.emit('annotation:cancel-pending', undefined);
        setNewCommentText('');
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [pendingAnnotation]);

  return (
    <div className="semiont-panel">
      <PanelHeader annotationType="comment" count={annotations.length} title={t('title')} />

      {/* New comment input - shown when there's a pending annotation with commenting motivation */}
      {pendingAnnotation && pendingAnnotation.motivation === 'commenting' && (
        <div className="semiont-annotation-prompt" data-type="comment">
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
            value={newCommentText}
            onChange={(e) => setNewCommentText(e.target.value)}
            className="semiont-textarea"
            rows={3}
            placeholder={t('commentPlaceholder')}
            autoFocus
            maxLength={2000}
          />
          <div className="semiont-annotation-prompt__footer">
            <span className="semiont-annotation-prompt__char-count">
              {newCommentText.length}/2000
            </span>
            <div className="semiont-annotation-prompt__actions">
              <button
                onClick={() => {
                  eventBus.emit('annotation:cancel-pending', undefined);
                  setNewCommentText('');
                }}
                className="semiont-button semiont-button--secondary"
                data-type="comment"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleSaveNewComment}
                disabled={!newCommentText.trim()}
                className="semiont-button semiont-button--primary"
                data-type="comment"
              >
                {t('save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scrollable content area */}
      <div ref={containerRef} className="semiont-panel__content">
        {/* Detection Section - only in Annotate mode and for text resources */}
        {annotateMode && (
          <DetectSection
            annotationType="comment"
            isDetecting={isDetecting}
            detectionProgress={detectionProgress}
          />
        )}

        {/* Comments list */}
        <div className="semiont-panel__list">
          {sortedAnnotations.length === 0 ? (
            <p className="semiont-panel__empty">
              {t('noComments')}
            </p>
          ) : (
            sortedAnnotations.map((comment) => (
              <CommentEntry
                key={comment.id}
                comment={comment}
                isFocused={comment.id === focusedAnnotationId}
                annotateMode={annotateMode}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
