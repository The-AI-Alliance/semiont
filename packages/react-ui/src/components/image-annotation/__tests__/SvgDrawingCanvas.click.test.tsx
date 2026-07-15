/**
 * A1 anchor thread — image canvas drawing-path hit-test pin.
 *
 * In drawing mode, a sub-10px "click" on an existing annotation goes through
 * the mouse-up hit-test (not the overlay's element handlers): the hit-test
 * owns the display-coordinate transform and must emit browse.click with the
 * annotation's viewport rect (display rect offset by the image's position —
 * zeros in jsdom, so viewport == display coordinates here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { Annotation, AnnotationId } from '@semiont/core';
import { SvgDrawingCanvas } from '../SvgDrawingCanvas';

// jsdom's Image never fires onload; the canvas loads natural dimensions via a
// detached `new Image()`. Stub it to report 100×100 synchronously-ish.
class FakeImage {
  onload: (() => void) | null = null;
  naturalWidth = 100;
  naturalHeight = 100;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

const rectAnnotation: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'canvas-ann-1' as AnnotationId,
  type: 'Annotation',
  motivation: 'highlighting',
  created: '2024-01-01T10:00:00Z',
  target: {
    source: 'resource-1',
    selector: {
      type: 'SvgSelector',
      value: '<svg><rect x="10" y="10" width="20" height="20"/></svg>',
    },
  },
};

function sessionDouble() {
  const click = vi.fn();
  const session = {
    client: {
      browse: { click },
      beckon: { hover: vi.fn() },
    },
  } as unknown as SemiontSession;
  return { session, click };
}

describe('SvgDrawingCanvas — drawing-path hit-test anchorRect', () => {
  beforeEach(() => {
    vi.stubGlobal('Image', FakeImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits browse.click with the hit annotation viewport rect on a sub-10px click', async () => {
    const { session, click } = sessionDouble();

    const { container } = render(
      <SvgDrawingCanvas
        imageUrl="http://test/image.png"
        resourceUri="resource-1"
        existingAnnotations={[rectAnnotation]}
        drawingMode="rectangle"
        selectedMotivation="highlighting"
        session={session}
      />,
    );

    // Wait for the stubbed Image load to land imageDimensions (overlay mounts).
    await waitFor(() => {
      expect(container.querySelector('.semiont-svg-drawing-canvas__overlay-container')).toBeInTheDocument();
    });

    // jsdom has no layout: give the rendered <img> display dimensions and let
    // the resize listener re-read them (display 200×200 over natural 100×100
    // → scale 2, so the 10,10,20,20 annotation displays at 20,20,40,40).
    const img = container.querySelector('.semiont-svg-drawing-canvas__image') as HTMLImageElement;
    Object.defineProperty(img, 'clientWidth', { value: 200, configurable: true });
    Object.defineProperty(img, 'clientHeight', { value: 200, configurable: true });
    fireEvent(window, new Event('resize'));

    await waitFor(() => {
      const overlay = container.querySelector('.semiont-svg-drawing-canvas__overlay') as HTMLElement;
      expect(overlay?.style.width).toBe('200px');
    });

    // Sub-10px gesture inside the displayed annotation (image rect is zeros
    // in jsdom, so client coordinates are display coordinates).
    const canvas = container.querySelector('.semiont-svg-drawing-canvas')!;
    fireEvent.mouseDown(canvas, { clientX: 30, clientY: 30 });
    fireEvent.mouseUp(canvas, { clientX: 30, clientY: 30 });

    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.calls[0]?.[0]).toBe('canvas-ann-1');
    expect(click.mock.calls[0]?.[1]).toBe('highlighting');
    expect(click.mock.calls[0]?.[2]).toEqual({
      x: 20, y: 20, left: 20, top: 20, width: 40, height: 40, right: 60, bottom: 60,
    });
  });
});
