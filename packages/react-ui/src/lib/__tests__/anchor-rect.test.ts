/**
 * A1 anchor thread — the display→viewport conversion both canvas hit-tests
 * share (image + PDF). Pure math: the origin is the canvas image's viewport
 * position; x/y/width/height are the hit annotation's display-coordinate rect.
 */
import { describe, it, expect } from 'vitest';
import { toViewportAnchorRect } from '../anchor-rect';

describe('toViewportAnchorRect', () => {
  it('offsets the display rect by the origin and derives all edges', () => {
    const rect = toViewportAnchorRect({ left: 100, top: 50 }, 20, 30, 40, 60);

    expect(rect).toEqual({
      x: 120,
      y: 80,
      left: 120,
      top: 80,
      width: 40,
      height: 60,
      right: 160,
      bottom: 140,
    });
  });

  it('is the identity offset at a zero origin (jsdom canvases)', () => {
    const rect = toViewportAnchorRect({ left: 0, top: 0 }, 10, 10, 20, 20);

    expect(rect.left).toBe(10);
    expect(rect.top).toBe(10);
    expect(rect.right).toBe(30);
    expect(rect.bottom).toBe(30);
    expect(rect.x).toBe(rect.left);
    expect(rect.y).toBe(rect.top);
  });
});
