import type { ReactNode } from 'react';
import { getSupportedShapes, type ShapeType } from '@semiont/react-ui';
import { PrefMenu } from './PrefMenu';

/**
 * The per-resource shape selector — a badge next to the pencil, shown only while that
 * resource is in annotate mode (the host gates on its own `annotate` state).
 *
 * `getSupportedShapes(mediaType)` is the single source of truth: fewer than two supported
 * shapes → no control (nothing to choose — the host passes the one shape through, or none
 * apply). No media-type special-casing here; a medium where shapes don't apply reports an
 * empty set (text → none, pdf → rectangle only, images → all three).
 */
export function ShapeControl({
  mediaType,
  shape,
  onShapeChange,
  className,
}: {
  mediaType: string;
  shape: ShapeType;
  onShapeChange: (shape: ShapeType) => void;
  /** Placement classes on the popover root — include `prefctl--down` to open the menu
   *  downward (header placement); the default opens upward (icon-row placement). */
  className?: string;
}) {
  const supported = getSupportedShapes(mediaType);
  const options = SHAPE_OPTIONS.filter((o) => supported.includes(o.value));
  if (options.length < 2) return null;
  return (
    <PrefMenu
      ariaLabel="Annotation shape"
      {...(className !== undefined ? { className } : {})}
      options={options}
      value={shape}
      onChange={onShapeChange}
    />
  );
}

// Same order + iconography as react-ui's own toolbar (▭ ○ ⬡), drawn as Lucide-style glyphs
// to match the pencil badge.
const SHAPE_OPTIONS: Array<{ value: ShapeType; icon: ReactNode; label: string; hint: string }> = [
  { value: 'rectangle', icon: <RectangleGlyph />, label: 'Rectangle', hint: 'Draw rectangle annotations' },
  { value: 'circle', icon: <CircleGlyph />, label: 'Circle', hint: 'Draw circle annotations' },
  { value: 'polygon', icon: <PolygonGlyph />, label: 'Polygon', hint: 'Draw polygon annotations' },
];

function RectangleGlyph() {
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
      <rect x="3" y="6" width="18" height="12" rx="1" />
    </svg>
  );
}

function CircleGlyph() {
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
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function PolygonGlyph() {
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
      <path d="M21 16.05V7.95a2 2 0 0 0-1-1.73l-7-4.05a2 2 0 0 0-2 0L4 6.22a2 2 0 0 0-1 1.73v8.1a2 2 0 0 0 1 1.73l7 4.05a2 2 0 0 0 2 0l7-4.05a2 2 0 0 0 1-1.73z" />
    </svg>
  );
}
