'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { CommentEntry } from './CommentEntry';
import { useAnnotationPanel } from '@/hooks/useAnnotationPanel';
import { DetectSection } from './DetectSection';
import { PanelHeader } from './PanelHeader';

type Annotation = components['schemas']['Annotation'];

interface CommentsPanelProps {
  comments: Annotation[];
  onCommentClick: (annotation: Annotation) => void;
  onUpdateComment: (annotationId: string, newText: string) => void;
  onCreateComment?: (commentText: string) => void;
  focusedCommentId: string | null;
  hoveredCommentId?: string | null;
  onCommentHover?: (commentId: string | null) => void;
  resourceContent: string;
  pendingSelection?: {
    exact: string;
    start: number;
    end: number;
  } | null;
  annotateMode?: boolean;
  onDetectComments?: (instructions?: string, tone?: string) => void | Promise<void>;
  isDetecting?: boolean;
  detectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
  } | null;
}

export function CommentsPanel({
  comments,
  onCommentClick,
  onUpdateComment,
  onCreateComment,
  focusedCommentId,
  hoveredCommentId,
  onCommentHover,
  resourceContent,
  pendingSelection,
  annotateMode = true,
  onDetectComments,
  isDetecting = false,
  detectionProgress,
}: CommentsPanelProps) {
  const t = useTranslations('CommentsPanel');
  const [newCommentText, setNewCommentText] = useState('');

  const { sortedAnnotations: sortedComments, containerRef, handleAnnotationRef } =
    useAnnotationPanel(comments, hoveredCommentId);

  const handleSaveNewComment = () => {
    if (onCreateComment && newCommentText.trim()) {
      onCreateComment(newCommentText);
      setNewCommentText('');
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <PanelHeader annotationType="comment" count={comments.length} title={t('title')} />

      {/* New comment input - shown when there's a pending selection */}
      {pendingSelection && onCreateComment && (
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
        {annotateMode && onDetectComments && (
          <DetectSection
            annotationType="comment"
            isDetecting={isDetecting}
            detectionProgress={detectionProgress}
            onDetect={onDetectComments}
          />
        )}

        {/* Comments list */}
        <div className="space-y-4">
          {sortedComments.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-sm">
              {t('noComments')}
            </p>
          ) : (
            sortedComments.map((comment) => (
              <CommentEntry
                key={comment.id}
                comment={comment}
                isFocused={comment.id === focusedCommentId}
                onClick={() => onCommentClick(comment)}
                onUpdate={(newText) => onUpdateComment(comment.id, newText)}
                onCommentRef={handleAnnotationRef}
                {...(onCommentHover && { onCommentHover })}
                resourceContent={resourceContent}
                annotateMode={annotateMode}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
