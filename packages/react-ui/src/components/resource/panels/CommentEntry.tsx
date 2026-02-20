'use client';

import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText, getCommentText } from '@semiont/api-client';
import { useEventBus } from '../../../contexts/EventBusContext';
import { useHoverEmitter } from '../../../hooks/useAttentionFlow';

type Annotation = components['schemas']['Annotation'];

interface CommentEntryProps {
  comment: Annotation;
  isFocused: boolean;
  isHovered?: boolean;
  annotateMode?: boolean;
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

export const CommentEntry = forwardRef<HTMLDivElement, CommentEntryProps>(
  function CommentEntry(
    {
      comment,
      isFocused,
      isHovered = false,
      annotateMode = true,
    },
    ref
  ) {
  const t = useTranslations('CommentsPanel');
  const eventBus = useEventBus();
  const hoverProps = useHoverEmitter(comment.id);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const internalRef = useRef<HTMLDivElement>(null);

  // Combine external ref with internal ref
  useImperativeHandle(ref, () => internalRef.current!);

  const commentText = getCommentText(comment) || '';
  const selectedText = getAnnotationExactText(comment);

  // Scroll into view when focused
  useEffect(() => {
    if (isFocused && internalRef.current) {
      internalRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [isFocused]);

  const handleEditClick = () => {
    setEditText(commentText);
    setIsEditing(true);
  };

  const handleSave = () => {
    // TODO: implement update handler via UpdateConfig
    setIsEditing(false);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditText('');
  };

  return (
    <div
      ref={internalRef}
      className={`semiont-annotation-entry${isHovered ? ' semiont-annotation-pulse' : ''}`}
      data-type="comment"
      data-focused={isFocused ? 'true' : 'false'}
      onClick={() => {
        eventBus.get('annotation:click').next({ annotationId: comment.id, motivation: comment.motivation });
      }}
      {...hoverProps}
    >
      {/* Selected text quote - only for text annotations */}
      {selectedText && (
        <div className="semiont-annotation-entry__quote" data-type="comment">
          "{selectedText.substring(0, 100)}{selectedText.length > 100 ? '...' : ''}"
        </div>
      )}

      {/* Comment body */}
      {isEditing ? (
        <div className="semiont-annotation-entry__edit" onClick={(e) => e.stopPropagation()}>
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            className="semiont-textarea"
            rows={3}
            autoFocus
            maxLength={2000}
          />
          <div className="semiont-annotation-entry__edit-footer">
            <span className="semiont-annotation-entry__char-count">
              {editText.length}/2000
            </span>
            <div className="semiont-annotation-entry__button-group">
              <button
                onClick={handleSave}
                className="semiont-button semiont-button--primary"
                data-type="comment"
              >
                {t('save')}
              </button>
              <button
                onClick={handleCancel}
                className="semiont-button semiont-button--secondary"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="semiont-annotation-entry__body">{commentText}</div>
      )}

      {/* Metadata and actions */}
      {!isEditing && (
        <div className="semiont-annotation-entry__footer">
          <div className="semiont-annotation-entry__metadata">
            By {typeof comment.creator === 'string' ? comment.creator : comment.creator?.name || 'Unknown'} • {formatRelativeTime(comment.created || new Date().toISOString())}
          </div>
          {annotateMode && (
            <div className="semiont-annotation-entry__actions" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={handleEditClick}
                className="semiont-text-button"
                data-variant="comment"
              >
                {t('edit')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
