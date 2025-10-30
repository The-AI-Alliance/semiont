'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText, getCommentText } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

interface CommentEntryProps {
  comment: Annotation;
  isFocused: boolean;
  onClick: () => void;
  onDelete: () => void;
  onUpdate: (newText: string) => void;
  resourceContent: string;
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;

  return date.toLocaleDateString();
}

export function CommentEntry({
  comment,
  isFocused,
  onClick,
  onDelete,
  onUpdate,
  resourceContent,
}: CommentEntryProps) {
  const t = useTranslations('CommentsPanel');
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const commentRef = useRef<HTMLDivElement>(null);

  // Scroll to comment when focused
  useEffect(() => {
    if (isFocused && commentRef.current) {
      commentRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isFocused]);

  const commentText = getCommentText(comment) || '';
  const selectedText = getAnnotationExactText(comment);

  const handleEditClick = () => {
    setEditText(commentText);
    setIsEditing(true);
  };

  const handleSave = () => {
    onUpdate(editText);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditText('');
  };

  return (
    <div
      ref={commentRef}
      className={`border rounded-lg p-3 transition-all cursor-pointer ${
        isFocused
          ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 animate-pulse-outline'
          : 'border-gray-200 dark:border-gray-700 hover:border-purple-300'
      }`}
      onClick={onClick}
    >
      {/* Selected text quote */}
      <div className="text-sm text-gray-600 dark:text-gray-400 italic mb-2 border-l-2 border-purple-300 pl-2">
        "{selectedText?.substring(0, 100)}{(selectedText?.length || 0) > 100 ? '...' : ''}"
      </div>

      {/* Comment body */}
      {isEditing ? (
        <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            className="w-full p-2 border rounded text-sm dark:bg-gray-800 dark:border-gray-600"
            rows={3}
            autoFocus
            maxLength={2000}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              {editText.length}/2000
            </span>
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                className="text-sm px-3 py-1 bg-purple-600 text-white rounded hover:bg-purple-700"
              >
                {t('save')}
              </button>
              <button
                onClick={handleCancel}
                className="text-sm px-3 py-1 border rounded hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="text-sm mb-2 whitespace-pre-wrap">{commentText}</div>
      )}

      {/* Metadata and actions */}
      {!isEditing && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <div>
            By {typeof comment.creator === 'string' ? comment.creator : comment.creator?.name || 'Unknown'} • {formatRelativeTime(comment.created || new Date().toISOString())}
          </div>
          <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={handleEditClick}
              className="hover:text-purple-600 dark:hover:text-purple-400"
            >
              {t('edit')}
            </button>
            <button
              onClick={onDelete}
              className="hover:text-red-600 dark:hover:text-red-400"
            >
              🗑️
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
