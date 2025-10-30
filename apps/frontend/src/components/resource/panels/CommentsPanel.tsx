'use client';

import React, { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';
import { CommentEntry } from './CommentEntry';

type Annotation = components['schemas']['Annotation'];

interface CommentsPanelProps {
  comments: Annotation[];
  onCommentClick: (annotation: Annotation) => void;
  onDeleteComment: (annotationId: string) => void;
  onUpdateComment: (annotationId: string, newText: string) => void;
  onCreateComment?: (commentText: string) => void;
  focusedCommentId: string | null;
  resourceContent: string;
  pendingSelection?: {
    exact: string;
    start: number;
    end: number;
  } | null;
}

export function CommentsPanel({
  comments,
  onCommentClick,
  onDeleteComment,
  onUpdateComment,
  onCreateComment,
  focusedCommentId,
  resourceContent,
  pendingSelection,
}: CommentsPanelProps) {
  const t = useTranslations('CommentsPanel');
  const [newCommentText, setNewCommentText] = useState('');

  // Sort comments by their position in the resource
  const sortedComments = useMemo(() => {
    return [...comments].sort((a, b) => {
      const aSelector = getTextPositionSelector(getTargetSelector(a.target));
      const bSelector = getTextPositionSelector(getTargetSelector(b.target));
      if (!aSelector || !bSelector) return 0;
      return aSelector.start - bSelector.start;
    });
  }, [comments]);

  const handleSaveNewComment = () => {
    if (onCreateComment && newCommentText.trim()) {
      onCreateComment(newCommentText);
      setNewCommentText('');
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          💬 {t('title')} ({comments.length})
        </h2>
      </div>

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

      {/* Comments list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
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
              onDelete={() => onDeleteComment(comment.id)}
              onUpdate={(newText) => onUpdateComment(comment.id, newText)}
              resourceContent={resourceContent}
            />
          ))
        )}
      </div>
    </div>
  );
}
