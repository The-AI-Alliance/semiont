import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AssessmentEntry,
  CommentEntry,
  HighlightEntry,
  ReferenceEntry,
  TagEntry,
} from '@semiont/react-ui';
import type { AnchorRect, Annotation } from '@semiont/core';
import type { ChatSession } from '../lib/session';

const CARD_WIDTH = 320;

/**
 * The 🔎 detail click action's surface: the clicked annotation's full record — quote,
 * body, referent link, Via attestation, annotate-mode actions — as a click-pinned popover.
 * The body is the Browser's own per-motivation panel ENTRY (stock react-ui, mountable
 * provider-free since the panels took `session` as a prop); chat supplies only the chrome.
 *
 * Anchored to the clicked annotation's own rect — the `AnchorRect` that rides
 * `browse:click` → `onOpenPanel` from every emitter (text span, image shape, PDF overlay),
 * so placement is uniform across media.
 */
export function AnnotationDetailCard({
  session,
  annotation,
  anchorRect,
  annotateMode,
  onOpenResource,
  onClose,
}: {
  session: ChatSession;
  annotation: Annotation;
  /** The clicked annotation's viewport rect, from the detail emission. */
  anchorRect: AnchorRect;
  /** The bubble's pencil state — off renders the entry read-only. */
  annotateMode: boolean;
  /** The entry's referent link (resolved references) — host-owned nav. */
  onOpenResource: (id: string) => void;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Esc + click-away dismiss (mousedown, so a click that opens another annotation's
  // detail closes this card first and the new one opens from the fresh emission).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (cardRef.current !== null && e.target instanceof Node && !cardRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  // Below the annotation when there's room, above it near the viewport bottom — the
  // AnchoredHovercard placement idiom, clamped horizontally.
  const style: CSSProperties = useMemo(() => {
    const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - CARD_WIDTH - 8);
    const base: CSSProperties = { position: 'fixed', left, width: CARD_WIDTH, zIndex: 60 };
    return anchorRect.bottom < window.innerHeight - 220
      ? { ...base, top: anchorRect.bottom + 6 }
      : { ...base, bottom: window.innerHeight - anchorRect.top + 6 };
  }, [anchorRect]);

  return createPortal(
    <div ref={cardRef} className="adetail" style={style} role="dialog" aria-label="Annotation details">
      {entryFor(session, annotation, annotateMode, onOpenResource)}
    </div>,
    document.body,
  );
}

/** The stock entry for the annotation's motivation — each takes its annotation under a
 *  motivation-named prop. `isFocused` stays false: the pinned card IS the focus. */
function entryFor(
  session: ChatSession,
  annotation: Annotation,
  annotateMode: boolean,
  onOpenResource: (id: string) => void,
): ReactNode {
  const motivation = Array.isArray(annotation.motivation) ? annotation.motivation[0] : annotation.motivation;
  switch (motivation) {
    case 'highlighting':
      return <HighlightEntry session={session} highlight={annotation} isFocused={false} />;
    case 'linking':
      return (
        <ReferenceEntry
          session={session}
          reference={annotation}
          isFocused={false}
          annotateMode={annotateMode}
          onOpenResource={onOpenResource}
        />
      );
    case 'assessing':
      return <AssessmentEntry session={session} assessment={annotation} isFocused={false} />;
    case 'commenting':
      return <CommentEntry session={session} comment={annotation} isFocused={false} annotateMode={annotateMode} />;
    case 'tagging':
      return <TagEntry session={session} tag={annotation} isFocused={false} />;
    default:
      return <p className="adetail__unknown">No detail view for “{String(motivation)}” annotations.</p>;
  }
}
