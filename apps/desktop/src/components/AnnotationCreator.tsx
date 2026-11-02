import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { usePendingCreation } from '@semiont/react-ui';
import { resourceId as brandResourceId, type ResourceId } from '@semiont/sdk';
import {
  createAnnotationFromSelection,
  type AnnotationBody,
  type PendingMotivation,
  type PendingSelector,
} from '../lib/annotations';
import type { ChatSession } from '../lib/session';
import { LinkSelectionPopover } from './LinkSelectionPopover';

const CARD_WIDTH = 320;

/** A viewer selection awaiting host UI (target chooser / comment box) before creation. */
export interface PendingCreation {
  selector: PendingSelector;
  motivation: PendingMotivation;
  /** Where the selection gesture ended — anchors the popover. */
  at: { x: number; y: number };
}

/**
 * Chat's creation POLICY over react-ui's `usePendingCreation` seam (HEADLESS-CREATION-SEAM:
 * the claim-by-source hook moved up to the library; dispatch and chrome stay here). The
 * library hook claims this viewer's `mark:requested` events (annotate-mode gated); this
 * wrapper adds what's host policy, mirroring the Browser's motivation semantics:
 *  - highlighting / assessing → create immediately, no body;
 *  - linking → popover FIRST (chat's target chooser), created pre-resolved on pick;
 *  - commenting / tagging → popover with a text body input;
 * plus the popover anchor — where the selection gesture ended (document-capture mouseup;
 * the viewer's internals stop propagation).
 */
export function useAnnotationCreation(
  session: ChatSession,
  resourceId: ResourceId,
  enabled: boolean,
): { pending: PendingCreation | null; clearPending: () => void } {
  const [pending, setPending] = useState<PendingCreation | null>(null);
  const { pending: claimed, clearPending: clearClaimed } = usePendingCreation(session, resourceId, enabled);

  const lastUp = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      lastUp.current = { x: e.clientX, y: e.clientY };
    };
    document.addEventListener('mouseup', onUp, true);
    return () => document.removeEventListener('mouseup', onUp, true);
  }, []);

  // Dispatch each claimed request, then free the claim slot (a reselect claims anew and
  // overwrites — the seam's replace-on-reselect semantics carry through).
  useEffect(() => {
    if (claimed === null) return;
    const { selector, motivation } = claimed;
    if (motivation === 'highlighting' || motivation === 'assessing') {
      void createAnnotationFromSelection(session, resourceId, selector, motivation);
    } else {
      setPending({ selector, motivation, at: lastUp.current });
    }
    clearClaimed();
  }, [claimed, clearClaimed, session, resourceId]);

  return { pending, clearPending: () => setPending(null) };
}

/** The popover for pendings that need input: linking → target chooser; comment/tag → text. */
export function PendingCreationPopover({
  session,
  resourceId,
  pending,
  onClose,
}: {
  session: ChatSession;
  resourceId: ResourceId;
  pending: PendingCreation;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const style: CSSProperties = {
    position: 'fixed',
    left: Math.min(Math.max(8, pending.at.x - 20), window.innerWidth - CARD_WIDTH - 8),
    top: Math.min(pending.at.y + 10, window.innerHeight - 260),
    width: CARD_WIDTH,
    zIndex: 60,
  };

  const create = async (body?: AnnotationBody) => {
    try {
      await createAnnotationFromSelection(session, resourceId, pending.selector, pending.motivation, body);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  let content: React.ReactNode;
  if (pending.motivation === 'linking') {
    content = (
      <LinkSelectionPopover
        session={session}
        excludeId={String(resourceId)}
        style={{}}
        onPick={(c) => void create({ type: 'SpecificResource', source: brandResourceId(c.id), purpose: 'linking' })}
        onClose={onClose}
      />
    );
  } else if (pending.motivation === 'commenting' || pending.motivation === 'tagging') {
    content = (
      <TextBodyForm
        motivation={pending.motivation}
        onSave={(text) => void create({ type: 'TextualBody', value: text, purpose: pending.motivation as 'commenting' | 'tagging' })}
        onClose={onClose}
      />
    );
  } else {
    return null; // immediate motivations never reach the popover
  }

  return createPortal(
    <div style={style}>
      {content}
      {error !== null && (
        <p className="linksel__error" role="alert">
          {error}
        </p>
      )}
    </div>,
    document.body,
  );
}

/** Minimal body input for comment/tag creation (the Browser uses its side panels here). */
function TextBodyForm({
  motivation,
  onSave,
  onClose,
}: {
  motivation: 'commenting' | 'tagging';
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const isComment = motivation === 'commenting';
  const save = () => {
    if (text.trim()) onSave(text.trim());
  };
  return (
    <div className="annform" role="dialog" aria-label={isComment ? 'Add comment' : 'Add tag'}>
      {isComment ? (
        <textarea
          className="annform__text"
          rows={3}
          placeholder="Comment on the selection…"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
          }}
        />
      ) : (
        <input
          className="annform__text"
          type="text"
          placeholder="Tag the selection…"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter') save();
          }}
        />
      )}
      <div className="annform__row">
        <button type="button" className="annform__cancel" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="annform__save" onClick={save} disabled={!text.trim()}>
          {isComment ? 'Comment' : 'Tag'}
        </button>
      </div>
    </div>
  );
}
