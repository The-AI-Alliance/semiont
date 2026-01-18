'use client';

import React, { useState } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { components } from '@semiont/api-client';
import { CommentEntry } from './CommentEntry';
import { useAnnotationPanel } from '../../../hooks/useAnnotationPanel';
import { DetectSection } from './DetectSection';
import { PanelHeader } from './PanelHeader';

type Annotation = components['schemas']['Annotation'];

interface CommentsPanelProps {
  annotations: Annotation[];
  onAnnotationClick: (annotation: Annotation) => void;
  onUpdate: (annotationId: string, newText: string) => void;
  onCreate?: (commentText: string) => void;
  focusedAnnotationId: string | null;
  hoveredAnnotationId?: string | null;
  onAnnotationHover?: (annotationId: string | null) => void;
  pendingSelection?: {
    exact: string;
    start: number;
    end: number;
  } | null;
  annotateMode?: boolean;
  onDetect?: (instructions?: string, tone?: string) => void | Promise<void>;
  isDetecting?: boolean;
  detectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
  } | null;
}

export function CommentsPanel({
  annotations,
  onAnnotationClick,
  onUpdate,
  onCreate,
  focusedAnnotationId,
  hoveredAnnotationId,
  onAnnotationHover,
  pendingSelection,
  annotateMode = true,
  onDetect,
  isDetecting = false,
  detectionProgress,
}: CommentsPanelProps) {
  const t = useTranslations('CommentsPanel');
  const [newCommentText, setNewCommentText] = useState('');

  const { sortedAnnotations, containerRef, handleAnnotationRef } =
    useAnnotationPanel(annotations, hoveredAnnotationId);

  const handleSaveNewComment = () => {
    if (onCreate && newCommentText.trim()) {
      onCreate(newCommentText);
      setNewCommentText('');
    }
  };

  return (
    <div className="semiont-panel">
      <PanelHeader annotationType="comment" count={annotations.length} title={t('title')} />

      {/* New comment input - shown when there's a pending selection */}
      {pendingSelection && onCreate && (
        <div className="semiont-annotation-prompt" data-type="comment">
          <div className="semiont-annotation-prompt__quote">
            "{pendingSelection.exact.substring(0, 100)}{pendingSelection.exact.length > 100 ? '...' : ''}"
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
      )}

      {/* Scrollable content area */}
      <div ref={containerRef} className="semiont-panel__content">
        {/* Detection Section - only in Annotate mode and for text resources */}
        {annotateMode && onDetect && (
          <DetectSection
            annotationType="comment"
            isDetecting={isDetecting}
            detectionProgress={detectionProgress}
            onDetect={onDetect}
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
                onClick={() => onAnnotationClick(comment)}
                onUpdate={(newText) => onUpdate(comment.id, newText)}
                onCommentRef={handleAnnotationRef}
                {...(onAnnotationHover && { onAnnotationHover })}
                annotateMode={annotateMode}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
