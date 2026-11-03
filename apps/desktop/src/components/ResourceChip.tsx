import { useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { ChatSession } from '../lib/session';
import { ResourceHovercard } from './ResourceHovercard';

const HOVER_DELAY_MS = 400;
const CARD_WIDTH = 320;

/**
 * An inline reference to a KB resource, shown as a compact pill: a document glyph + label.
 * Clickable (a button) when `onOpen` is given — opening the resource in the main pane — else a
 * static span. Shared by `@Name` mentions inside a question and the record left after a file
 * upload, so both read as the same "name chip".
 *
 * On hover (after a short dwell) it shows a `ResourceHovercard` — identity, metadata, and a peek —
 * portalled to `document.body` so it can't be clipped by the scrolling chat log, and rendered
 * `pointer-events: none` so moving toward it never steals the hover. The preview only appears when
 * `session` + `resourceId` are supplied (a completed resource).
 *
 * The label's text is the pill's only text node (the glyph carries none), so when a mention chip
 * renders inside a question its label must be the verbatim `@Name` token — the annotation overlay
 * maps source offsets onto the rendered text and depends on that text matching. (The hovercard is
 * portalled out of the paragraph, so it adds no text nodes to that mapping.)
 */
export function ResourceChip({
  label,
  onOpen,
  session,
  resourceId,
  fileUri,
}: {
  label: string;
  onOpen?: () => void;
  /** Together with `resourceId`, enables the lazy hover preview. */
  session?: ChatSession;
  resourceId?: string;
  /** Passed through to the preview so an upload shows its file URI without a fetch. */
  fileUri?: string;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [cardStyle, setCardStyle] = useState<CSSProperties | null>(null);

  const canPreview = session !== undefined && resourceId !== undefined;

  const place = () => {
    const el = anchorRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    const gap = 6;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - CARD_WIDTH - 8);
    const base: CSSProperties = { position: 'fixed', left, width: CARD_WIDTH };
    // Prefer above (where the already-read message is); flip below if there isn't room.
    setCardStyle(r.top > 260 ? { ...base, bottom: window.innerHeight - r.top + gap } : { ...base, top: r.bottom + gap });
  };
  const show = () => {
    if (!canPreview) return;
    timer.current = setTimeout(place, HOVER_DELAY_MS);
  };
  const hide = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    setCardStyle(null);
  };

  const inner = (
    <>
      <DocGlyph />
      <span className="rchip__label">{label}</span>
    </>
  );
  const chip =
    onOpen === undefined ? (
      <span className="rchip">{inner}</span>
    ) : (
      <button type="button" className="rchip rchip--btn" onClick={onOpen} title="Open referenced resource">
        {inner}
      </button>
    );

  return (
    <span
      ref={anchorRef}
      className="rchip-wrap"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={canPreview ? place : undefined}
      onBlur={hide}
    >
      {chip}
      {cardStyle !== null &&
        session !== undefined &&
        resourceId !== undefined &&
        createPortal(
          <div className="rcard-anchor" style={cardStyle}>
            <ResourceHovercard
              session={session}
              resourceId={resourceId}
              name={label.replace(/^@/, '')}
              {...(fileUri !== undefined ? { fileUri } : {})}
            />
          </div>,
          document.body,
        )}
    </span>
  );
}

function DocGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
