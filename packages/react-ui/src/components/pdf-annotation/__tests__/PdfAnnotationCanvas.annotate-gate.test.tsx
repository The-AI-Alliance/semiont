/**
 * A person may annotate a PDF only while the canvas holds the document's text.
 *
 * The quote of an annotation is cut from that text when the annotation is
 * made, and never again: a rectangle drawn without the text would have no
 * quote for good. So drawing is off until the text is held, whatever the
 * reason it is not: no answer yet, an answer that the text is not there yet,
 * an ask that failed, a document the Smelter declined, a resource nobody
 * knows. `no-map` is a text that is held and empty, as is an `extracted` text
 * with no words in it: drawing is on, and a rectangle has no quote.
 *
 * The canvas says which it is on its root, as `data-annotate-deferred`.
 * `useAnchoredText` has its own tests for every answer; these hold what the
 * canvas does with what it holds, through a real drag.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { renderInEnglish } from '../../../test-utils';
import '@testing-library/jest-dom';
import { ANCHORED_TEXT_REASK_MS, resourceId } from '@semiont/core';
import type { AnchoredTextAnswer } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';

vi.mock('../../../lib/browser-pdfjs', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({
    numPages: 2,
    getPage: vi.fn().mockResolvedValue({
      getViewport: vi.fn().mockReturnValue({ width: 612, height: 792, scale: 1.0, rotation: 0 }),
    }),
  }),
  renderPdfPageToDataUrl: vi.fn().mockResolvedValue({
    dataUrl: 'data:image/png;base64,mock',
    width: 612,
    height: 792,
  }),
}));

import { renderPdfPageToDataUrl } from '../../../lib/browser-pdfjs';
import { PdfAnnotationCanvas } from '../PdfAnnotationCanvas';

/** Let what has been started be answered: the document's load, and an ask. */
const answered = () => act(() => vi.advanceTimersByTimeAsync(0));
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const root = () => document.querySelector('.semiont-pdf-annotation-canvas');
const page = () => document.querySelector('.semiont-pdf-annotation-canvas__container');
const notice = () => document.querySelector('.semiont-anchored-text-notice');

/** "Hello world" on one line of page 1, at y=700 in PDF points — canvas
 *  y=80..92 on this 792pt page. */
const HELLO_WORLD: AnchoredTextAnswer = {
  kind: 'extracted',
  method: 'pdf-text-layer',
  text: 'Hello world\n',
  items: [
    { start: 0, end: 5, page: 1, x: 72, y: 700, width: 30, height: 12 },
    { start: 6, end: 11, page: 1, x: 106, y: 700, width: 32, height: 12 },
  ],
};

/** The canvas with a tool chosen, over a session whose anchored-text read is
 *  `ask`. `request` is where a drawn rectangle arrives. */
function mount(ask: SemiontSession['client']['browse']['resourceAnchoredText']) {
  const request = vi.fn();
  const session = {
    client: { browse: { resourceAnchoredText: ask }, mark: { request }, beckon: { hover: vi.fn() } },
  } as unknown as SemiontSession;
  const view = renderInEnglish(
    <PdfAnnotationCanvas
      resourceUri={resourceId('123')}
      pdfUrl="https://example.com/resources/123.pdf"
      drawingMode="rectangle"
      selectedMotivation="highlighting"
      session={session}
    />,
  );
  return { request, unmount: view.unmount };
}

/** Drag a box a little larger than the "Hello world" line. jsdom lays nothing
 *  out, so the image is first given the page's own size: display pixels are
 *  then PDF points, and the drag's coordinates the canvas's. */
function dragAroundHelloWorld() {
  const img = document.querySelector('.semiont-pdf-annotation-canvas__image') as HTMLImageElement;
  expect(img).toBeInTheDocument();
  Object.defineProperty(img, 'clientWidth', { value: 612, configurable: true });
  Object.defineProperty(img, 'clientHeight', { value: 792, configurable: true });
  fireEvent.load(img);

  fireEvent.mouseDown(page()!, { clientX: 70, clientY: 78 });
  fireEvent.mouseMove(page()!, { clientX: 146, clientY: 96 });
  fireEvent.mouseUp(page()!, { clientX: 146, clientY: 96 });
}

const A_RECTANGLE = expect.objectContaining({
  type: 'FragmentSelector',
  value: expect.stringContaining('page=1&viewrect='),
});

describe('PdfAnnotationCanvas — annotating waits for the text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('annotating is off before the first answer arrives, and a drag then makes no annotation', async () => {
    // The server may hold an ask while the Smelter reads a document just
    // uploaded. This one is never answered.
    const ask = vi.fn(() => new Promise<AnchoredTextAnswer>(() => { /* never answered */ }));
    const { request } = mount(ask);
    await answered();

    expect(ask).toHaveBeenCalledTimes(1);
    expect(root()).toHaveAttribute('data-annotate-deferred', 'true');
    expect(page()).toHaveAttribute('data-drawing-mode', 'none');
    expect(notice()).toHaveAttribute('data-anchored-text', 'waiting');
    expect(notice()).toHaveTextContent(/preparing/i);

    dragAroundHelloWorld();
    expect(request).not.toHaveBeenCalled();
  });

  test('`not-yet` is asked again after the wait, and annotating turns on when the text lands, the first drag carrying its quote', async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce({ kind: 'not-yet' })
      .mockResolvedValue(HELLO_WORLD);
    const { request } = mount(ask);
    await answered();

    expect(root()).toHaveAttribute('data-annotate-deferred', 'true');
    expect(notice()).toHaveAttribute('data-anchored-text', 'waiting');
    dragAroundHelloWorld();
    expect(request).not.toHaveBeenCalled();

    await pass(ANCHORED_TEXT_REASK_MS);
    await answered();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(root()).toHaveAttribute('data-annotate-deferred', 'false');
    expect(page()).toHaveAttribute('data-drawing-mode', 'rectangle');
    expect(notice()).not.toBeInTheDocument();
    // The page is handed the text; it is not loaded a second time for it.
    expect(vi.mocked(renderPdfPageToDataUrl)).toHaveBeenCalledTimes(1);

    dragAroundHelloWorld();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toEqual([
      A_RECTANGLE,
      { type: 'TextQuoteSelector', exact: 'Hello world' },
    ]);

    // The text is held: nothing more is asked.
    await pass(ANCHORED_TEXT_REASK_MS * 10);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  test('a failed ask is asked again after the wait, and annotating turns on when the text lands, the first drag carrying its quote', async () => {
    const ask = vi.fn()
      .mockRejectedValueOnce(new Error('no answer'))
      .mockResolvedValue(HELLO_WORLD);
    const { request } = mount(ask);
    await answered();

    expect(root()).toHaveAttribute('data-annotate-deferred', 'true');
    expect(notice()).toHaveAttribute('data-anchored-text', 'waiting');
    dragAroundHelloWorld();
    expect(request).not.toHaveBeenCalled();

    await pass(ANCHORED_TEXT_REASK_MS);
    await answered();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(root()).toHaveAttribute('data-annotate-deferred', 'false');

    dragAroundHelloWorld();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toEqual([
      A_RECTANGLE,
      { type: 'TextQuoteSelector', exact: 'Hello world' },
    ]);
  });

  test.each<[string, AnchoredTextAnswer]>([
    ['`declined`', { kind: 'declined', declined: 'no-text-layer' }],
    ['`unknown`', { kind: 'unknown' }],
  ])('%s leaves annotating off, says the text could not be read, and is not asked again', async (_name, answer) => {
    const ask = vi.fn().mockResolvedValue(answer);
    const { request } = mount(ask);
    await answered();

    expect(root()).toHaveAttribute('data-annotate-deferred', 'true');
    expect(page()).toHaveAttribute('data-drawing-mode', 'none');
    expect(notice()).toHaveAttribute('data-anchored-text', 'never');
    expect(notice()).toHaveTextContent(/could not be read/i);

    dragAroundHelloWorld();
    expect(request).not.toHaveBeenCalled();

    await pass(ANCHORED_TEXT_REASK_MS * 10);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(root()).toHaveAttribute('data-annotate-deferred', 'true');
  });

  test.each<[string, AnchoredTextAnswer]>([
    ['`no-map`', { kind: 'no-map' }],
    ['an `extracted` answer whose text is empty', { kind: 'extracted', method: 'ocr', text: '', items: [] }],
  ])('%s turns annotating on, and a rectangle is made with no quote', async (_name, answer) => {
    const ask = vi.fn().mockResolvedValue(answer);
    const { request } = mount(ask);
    await answered();

    expect(root()).toHaveAttribute('data-annotate-deferred', 'false');
    expect(page()).toHaveAttribute('data-drawing-mode', 'rectangle');
    expect(notice()).not.toBeInTheDocument();

    dragAroundHelloWorld();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toEqual([A_RECTANGLE]);

    await pass(ANCHORED_TEXT_REASK_MS * 10);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  test('a canvas that unmounts while it waits asks nothing more', async () => {
    const ask = vi.fn().mockResolvedValue({ kind: 'not-yet' });
    const { unmount } = mount(ask);
    await answered();
    expect(ask).toHaveBeenCalledTimes(1);

    unmount();
    await pass(ANCHORED_TEXT_REASK_MS * 10);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  test('with no session there is nobody to ask: annotating is off, no line is shown, and a drag draws nothing', async () => {
    renderInEnglish(
      <PdfAnnotationCanvas
        resourceUri={resourceId('123')}
        pdfUrl="https://example.com/resources/123.pdf"
        drawingMode="rectangle"
        selectedMotivation="highlighting"
      />,
    );
    await answered();

    expect(root()).toHaveAttribute('data-annotate-deferred', 'true');
    expect(page()).toHaveAttribute('data-drawing-mode', 'none');
    expect(notice()).not.toBeInTheDocument();

    // The overlay is there to draw on, and the drag leaves nothing on it: not
    // even the dashed outline a rectangle keeps once it is drawn.
    dragAroundHelloWorld();
    const overlay = document.querySelector('.semiont-pdf-annotation-canvas__svg');
    expect(overlay).toBeInTheDocument();
    expect(overlay?.querySelectorAll('rect')).toHaveLength(0);
  });
});
