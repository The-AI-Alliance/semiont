'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { CommentEntry } from './CommentEntry';
import { useAnnotationPanel } from '../hooks/useAnnotationPanel';
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
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <PanelHeader annotationType="comment" count={annotations.length} title={t('title')} />

      {/* New comment input - shown when there's a pending selection */}
      {pendingSelection && onCreate && (
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-purple-50 dark:bg-purple-900/10">
          <div className="text-sm text-gray-600 dark:text-gray-400 italic mb-2 border-l-2 border-purple-300 pl-2">
            "{pendingSelection.exact.substring(0, 100)}{pendingSelection.exact.length > 100 ? '...' : ''}"
          </div>
          <textarea
            value={newCommentText}
            onChange={(e) => setNewCommentText(e.target.value)}
            className="w-full p-2 border rounded text-sm dark:bg-gray-800 dark:border-gray-600"
            rows={3}
            placeholder={t('commentPlaceholder')}
            autoFocus
            maxLength={2000}
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-gray-500">
              {newCommentText.length}/2000
            </span>
            <button
              onClick={handleSaveNewComment}
              disabled={!newCommentText.trim()}
              className="px-3 py-1 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              {t('save')}
            </button>
          </div>
        </div>
      )}

      {/* Scrollable content area */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-6">
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
        <div className="space-y-4">
          {sortedAnnotations.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-sm">
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
