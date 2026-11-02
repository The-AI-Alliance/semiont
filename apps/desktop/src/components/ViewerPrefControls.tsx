import type { ReactNode } from 'react';
import type { ClickAction, SelectionMotivation } from '@semiont/react-ui';
import { PrefMenu } from './PrefMenu';

/**
 * The app-global viewer preferences (UNIFY/toolbar split): what clicking an annotation does,
 * and what selecting text creates in annotate mode. One bundle — values + setters — threaded
 * from App to every mounted viewer (controlled props) and to the footer controls below.
 * Mode is deliberately NOT here: it's per-message (the pencil in each bubble/pane).
 */
export interface ViewerPrefs {
  clickAction: ClickAction;
  onClickActionChange: (action: ClickAction) => void;
  motivation: SelectionMotivation | null;
  onMotivationChange: (motivation: SelectionMotivation | null) => void;
}

const CLICK_OPTIONS: Array<{ value: ClickAction; icon: ReactNode; label: string; hint: string }> = [
  { value: 'follow', icon: '➡️', label: 'Follow', hint: 'Open the referenced resource' },
  { value: 'detail', icon: '🔎', label: 'Detail', hint: 'Show the annotation’s details' },
  { value: 'jsonld', icon: '🧾', label: 'JSON-LD', hint: 'Inspect the annotation as JSON-LD' },
  { value: 'deleting', icon: '🗑️', label: 'Delete', hint: 'Delete the clicked annotation' },
];

const MOTIVATION_OPTIONS: Array<{ value: SelectionMotivation; icon: ReactNode; label: string; hint: string }> = [
  { value: 'linking', icon: <LinkGlyph />, label: 'Reference', hint: 'Link the selection to a resource' },
  { value: 'highlighting', icon: <HighlighterGlyph />, label: 'Highlight', hint: 'Highlight the selection' },
  { value: 'commenting', icon: '💬', label: 'Comment', hint: 'Comment on the selection' },
  { value: 'assessing', icon: <UnderlineGlyph />, label: 'Assess', hint: 'Assess the selection' },
  { value: 'tagging', icon: '🏷️', label: 'Tag', hint: 'Tag the selection' },
];

/**
 * Two quiet icon controls for the chat footer (left of the Settings gear): click action and
 * selection motivation. Each shows the current value's icon and opens a small upward radio
 * popover. Global by construction — App owns the state and passes it to every viewer.
 */
export function ViewerPrefControls({ prefs }: { prefs: ViewerPrefs }) {
  return (
    <>
      <PrefMenu
        ariaLabel="Annotation click action"
        buttonIcon={<PointerGlyph />}
        options={CLICK_OPTIONS}
        value={prefs.clickAction}
        onChange={prefs.onClickActionChange}
      />
      <PrefMenu
        ariaLabel="Selection motivation"
        options={MOTIVATION_OPTIONS}
        value={prefs.motivation ?? 'linking'}
        onChange={prefs.onMotivationChange}
      />
    </>
  );
}

// Control-identity glyph for the click-action button (Lucide "mouse-pointer").
function PointerGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
      <path d="M13 13l6 6" />
    </svg>
  );
}

// Motivation glyphs carry their motivation's semantic color (yellow highlight, red assess) —
// fixed, not themed, matching the annotation tint the motivation produces.
function HighlighterGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#eab308"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 11-6 6v3h9l3-3" />
      <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </svg>
  );
}

function UnderlineGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#dc2626"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 4v6a6 6 0 0 0 12 0V4" />
      <line x1="4" y1="20" x2="20" y2="20" />
    </svg>
  );
}

function LinkGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#0891b2"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}
