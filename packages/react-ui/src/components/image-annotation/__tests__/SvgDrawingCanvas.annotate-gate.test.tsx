/**
 * An image is annotated under the rule a PDF is: only while the canvas holds
 * the resource's text.
 *
 * The canvas asks for the image's text itself, through the hook the PDF
 * canvas uses, wherever it is mounted and whatever drawing mode it is given,
 * and takes no drawing until the text is held. For an image the answer is
 * `no-map` — this media type has no text — which is a text that is held and
 * empty: drawing turns on, and a shape has no quote.
 *
 * The canvas says which it is on its own element, as `data-annotate-deferred`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderInEnglish } from '../../../test-utils';
import { ANCHORED_TEXT_REASK_MS, resourceId } from '@semiont/core';
import type { AnchoredTextAnswer } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { SvgDrawingCanvas } from '../SvgDrawingCanvas';

// jsdom's Image never fires onload; the canvas reads an image's own size from
// a detached `new Image()`. This one says 100×100 a moment after it is given
// a source.
class FakeImage {
  onload: (() => void) | null = null;
  naturalWidth = 100;
  naturalHeight = 100;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

const IMAGE = resourceId('image-1');

const canvas = () => document.querySelector('.semiont-svg-drawing-canvas');
const notice = () => document.querySelector('.semiont-anchored-text-notice');

/** The canvas with a tool chosen, over a session whose anchored-text read is
 *  `ask`. `request` is where a drawn shape arrives. */
function mount(ask: SemiontSession['client']['browse']['resourceAnchoredText']) {
  const request = vi.fn();
  const session = {
    client: { browse: { resourceAnchoredText: ask, click: vi.fn() }, mark: { request }, beckon: { hover: vi.fn() } },
  } as unknown as SemiontSession;
  renderInEnglish(
    <SvgDrawingCanvas
      imageUrl="http://test/image.png"
      resourceUri={IMAGE}
      drawingMode="rectangle"
      selectedMotivation="highlighting"
      session={session}
    />,
  );
  return { request };
}

/** jsdom lays nothing out: show the image at 200×200, twice its own size, and
 *  let the canvas read that. */
function layOutImage() {
  const img = document.querySelector('.semiont-svg-drawing-canvas__image') as HTMLImageElement;
  Object.defineProperty(img, 'clientWidth', { value: 200, configurable: true });
  Object.defineProperty(img, 'clientHeight', { value: 200, configurable: true });
  fireEvent(window, new Event('resize'));
}

/** Drag a rectangle from (20,20) to (120,90) on the shown image: (10,10) to
 *  (60,45) in the image's own pixels. */
function dragRectangle() {
  fireEvent.mouseDown(canvas()!, { clientX: 20, clientY: 20 });
  fireEvent.mouseMove(canvas()!, { clientX: 120, clientY: 90 });
  fireEvent.mouseUp(canvas()!, { clientX: 120, clientY: 90 });
}

describe('SvgDrawingCanvas — annotating waits for the text', () => {
  beforeEach(() => {
    vi.stubGlobal('Image', FakeImage);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('an image is not annotatable until its answer arrives, and is once `no-map` does: a rectangle with no quote', async () => {
    let give: (answer: AnchoredTextAnswer) => void = () => {};
    const ask = vi.fn(() => new Promise<AnchoredTextAnswer>((resolve) => { give = resolve; }));
    const { request } = mount(ask);

    await waitFor(() => {
      expect(document.querySelector('.semiont-svg-drawing-canvas__overlay-container')).toBeInTheDocument();
    });
    layOutImage();

    // Asked, and not answered: the image is shown and cannot be drawn on,
    // though a drawing mode was given.
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(IMAGE);
    expect(canvas()).toHaveAttribute('data-annotate-deferred', 'true');
    expect(canvas()).toHaveAttribute('data-drawing-mode', 'none');
    expect(notice()).toHaveAttribute('data-anchored-text', 'waiting');
    dragRectangle();
    expect(request).not.toHaveBeenCalled();

    await act(async () => { give({ kind: 'no-map' }); });

    await waitFor(() => expect(canvas()).toHaveAttribute('data-annotate-deferred', 'false'));
    expect(canvas()).toHaveAttribute('data-drawing-mode', 'rectangle');
    expect(notice()).not.toBeInTheDocument();

    dragRectangle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      IMAGE,
      { type: 'SvgSelector', value: '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="50" height="35"/></svg>' },
      'highlighting',
    );
  });

  it('an ask that fails is asked again after the wait, and the image opens when the answer comes', async () => {
    vi.useFakeTimers();
    const ask = vi.fn()
      .mockRejectedValueOnce(new Error('no answer'))
      .mockResolvedValue({ kind: 'no-map' });
    mount(ask);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(canvas()).toHaveAttribute('data-annotate-deferred', 'true');
    expect(canvas()).toHaveAttribute('data-drawing-mode', 'none');

    await act(() => vi.advanceTimersByTimeAsync(ANCHORED_TEXT_REASK_MS));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(canvas()).toHaveAttribute('data-annotate-deferred', 'false');
    expect(canvas()).toHaveAttribute('data-drawing-mode', 'rectangle');
  });

  it.each<[string, AnchoredTextAnswer]>([
    ['`declined`', { kind: 'declined', declined: 'corrupt' }],
    ['`unknown`', { kind: 'unknown' }],
  ])('%s leaves annotating off, says the text could not be read, and is not asked again', async (_name, answer) => {
    vi.useFakeTimers();
    const ask = vi.fn().mockResolvedValue(answer);
    mount(ask);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(canvas()).toHaveAttribute('data-annotate-deferred', 'true');
    expect(canvas()).toHaveAttribute('data-drawing-mode', 'none');
    expect(notice()).toHaveAttribute('data-anchored-text', 'never');
    expect(notice()).toHaveTextContent(/could not be read/i);

    await act(() => vi.advanceTimersByTimeAsync(ANCHORED_TEXT_REASK_MS * 10));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('given no drawing mode, as a read-only view gives none, it still asks and takes no drawing', async () => {
    const ask = vi.fn().mockResolvedValue({ kind: 'no-map' });
    const session = {
      client: { browse: { resourceAnchoredText: ask, click: vi.fn() }, beckon: { hover: vi.fn() } },
    } as unknown as SemiontSession;
    renderInEnglish(
      <SvgDrawingCanvas
        imageUrl="http://test/image.png"
        resourceUri={IMAGE}
        drawingMode={null}
        selectedMotivation={null}
        session={session}
      />,
    );

    await waitFor(() => expect(canvas()).toHaveAttribute('data-annotate-deferred', 'false'));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(canvas()).toHaveAttribute('data-drawing-mode', 'none');
  });

  it('with no session there is nobody to ask: the image cannot be drawn on, no line is shown, and no translations are needed', () => {
    // Plain `render`: a canvas with no session shows no line, so it reads no
    // translations and needs no provider for them.
    render(
      <SvgDrawingCanvas
        imageUrl="http://test/image.png"
        resourceUri={IMAGE}
        drawingMode="rectangle"
        selectedMotivation="highlighting"
      />,
    );

    expect(canvas()).toHaveAttribute('data-annotate-deferred', 'true');
    expect(canvas()).toHaveAttribute('data-drawing-mode', 'none');
    expect(notice()).not.toBeInTheDocument();
  });
});
