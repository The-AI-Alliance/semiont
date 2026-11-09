'use client';

import { useState, useEffect, useRef, useImperativeHandle, type Ref } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { Annotation, components } from '@semiont/core';
import { getAnnotationExactText, getCommentText, getTargetSource } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { useHoverEmitter } from '../../../hooks/useHoverEmitter';
import { creatorName, renderAgentLabels } from './agent-label';

type TextualBody = components['schemas']['TextualBody'];

/** An edit in progress: the session it is saved through, and its text. */
interface Edit {
  session: SemiontSession;
  text: string;
}

interface CommentEntryProps {
  /** Session for interaction routing (browse.click etc.); the panel threads it. */
  session: SemiontSession | null;
  comment: Annotation;
  isFocused: boolean;
  isHovered?: boolean;
  annotateMode?: boolean;
  ref?: Ref<HTMLDivElement>;
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

/**
 * @emits browse:click - This entry clicked. Payload: { annotationId: string }
 * @emits bind:update-body - Save an edit: replace the comment body item with one holding the edited text. Payload: BindUpdateBodyCommand
 */
export function CommentEntry({
  session,
  comment,
  isFocused,
  isHovered = false,
  annotateMode = true,
  ref,
}: CommentEntryProps) {
  const t = useTranslations('CommentsPanel');
  const hoverProps = useHoverEmitter(session, comment.id);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const internalRef = useRef<HTMLDivElement>(null);

  // Combine external ref with internal ref
  useImperativeHandle(ref, () => internalRef.current!);

  const commentText = getCommentText(comment) || '';
  const selectedText = getAnnotationExactText(comment);
  // The body item that holds the words shown, exactly as the annotation holds
  // it: an edit replaces this item, and a replace whose old item differs from
  // the held one in any member changes nothing.
  const bodyItems = comment.body === undefined ? [] : Array.isArray(comment.body) ? comment.body : [comment.body];
  const commentBody = bodyItems.find(
    (item): item is TextualBody => item.type === 'TextualBody' && item.value === commentText,
  );

  // Scroll into view when focused
  useEffect(() => {
    if (isFocused && internalRef.current) {
      internalRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [isFocused]);

  const handleEditClick = (editSession: SemiontSession) => {
    setSaveError(null);
    setEdit({ session: editSession, text: commentText });
  };

  const handleSave = (saved: Edit, heldBody: TextualBody) => {
    if (saved.text === heldBody.value) {
      setEdit(null);
      return;
    }
    setSaving(true);
    setSaveError(null);
    saved.session.client.bind.body(getTargetSource(comment.target), comment.id, [
      { op: 'replace', oldItem: heldBody, newItem: { ...heldBody, value: saved.text } },
    ]).then(
      () => {
        setSaving(false);
        setEdit(null);
      },
      (error: unknown) => {
        // The editor stays open with the edit, and says why it was not saved.
        setSaving(false);
        setSaveError(t('saveFailed', { detail: error instanceof Error ? error.message : String(error) }));
      },
    );
  };

  const handleCancel = () => {
    setEdit(null);
    setSaveError(null);
  };

  return (
    <div
      ref={internalRef}
      className={`semiont-annotation-entry${isHovered ? ' semiont-annotation-pulse' : ''}`}
      data-type="comment"
      data-focused={isFocused ? 'true' : 'false'}
      onClick={() => {
        session?.client.browse.click(comment.id);
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
      {edit && commentBody ? (
        <div className="semiont-annotation-entry__edit" onClick={(e) => e.stopPropagation()}>
          <textarea
            value={edit.text}
            onChange={(e) => setEdit({ ...edit, text: e.target.value })}
            className="semiont-textarea"
            rows={3}
            autoFocus
            maxLength={2000}
          />
          {saveError && (
            <p className="semiont-error-message" role="alert">{saveError}</p>
          )}
          <div className="semiont-annotation-entry__edit-footer">
            <span className="semiont-annotation-entry__char-count">
              {edit.text.length}/2000
            </span>
            <div className="semiont-annotation-entry__button-group">
              <button
                onClick={() => handleSave(edit, commentBody)}
                disabled={saving}
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
      {!(edit && commentBody) && (
        <div className="semiont-annotation-entry__footer">
          <div className="semiont-annotation-entry__metadata">
            {creatorName(comment.creator) && <>By {creatorName(comment.creator)} • </>}{formatRelativeTime(comment.created || new Date().toISOString())}
          </div>
          {comment.generator && renderAgentLabels(comment.generator) && (
            <div className="semiont-annotation-entry__metadata">
              Via {renderAgentLabels(comment.generator)}
            </div>
          )}
          {annotateMode && session && commentBody && (
            <div className="semiont-annotation-entry__actions" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => handleEditClick(session)}
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
}
