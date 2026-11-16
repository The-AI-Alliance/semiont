import type { AnchorRect } from '@semiont/core';

/**
 * Convert a rect in element-local display coordinates to a viewport-space
 * AnchorRect, offset by the element's own viewport position. Used by the
 * canvas hit-tests (image / PDF), whose annotation geometry lives in display
 * coordinates rather than on a DOM element.
 */
export function toViewportAnchorRect(
  origin: { left: number; top: number },
  x: number,
  y: number,
  width: number,
  height: number,
): AnchorRect {
  const left = origin.left + x;
  const top = origin.top + y;
  return { x: left, y: top, width, height, top, right: left + width, bottom: top + height, left };
}
