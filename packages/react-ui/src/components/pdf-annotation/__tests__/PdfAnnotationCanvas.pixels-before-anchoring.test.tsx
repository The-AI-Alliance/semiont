/**
 * The page's PIXELS must not wait for the document's text.
 *
 * Reading a PDF and annotating it are two things. The canvas asks the server
 * for the text and draws the pages at the same time, and a page appears on
 * its own schedule. The server holds that ask while the Smelter is still
 * reading a document, for as long as fifteen seconds: were a page to wait for
 * it, a person would look at a blank first page all that time, and not one
 * console error, because a wait is not a failure and nothing reports it.
 *
 * What waits for the text is ANNOTATING. These pin that the text's latency —
 * up to and including "never" — cannot hold the image, and that the text
 * which lands after the image is the one a rectangle is quoted from.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { renderInEnglish } from '../../../test-utils';
import '@testing-library/jest-dom';
import { resourceId } from '@semiont/core';
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

import { PdfAnnotationCanvas } from '../PdfAnnotationCanvas';

describe('PdfAnnotationCanvas — pixels before anchoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('a page shows its image while the ask for the text is still unanswered', async () => {
    // The ask HANGS — the server never answers. The image must not care.
    const resourceAnchoredText = vi.fn(() => new Promise(() => { /* never settles */ }));
    const session = {
      client: { browse: { resourceAnchoredText } },
    } as unknown as SemiontSession;

    renderInEnglish(
      <PdfAnnotationCanvas
        resourceUri={resourceId(String(resourceId('123')))}
        pdfUrl="https://example.com/resources/123.pdf"
        drawingMode={null}
        session={session}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('img[src^="data:image/png"]')).toBeInTheDocument();
    });
    // The text really was asked for — it just could not hold the pixels.
    expect(resourceAnchoredText).toHaveBeenCalled();
  });

  test('the text that lands after the image is the one a rectangle is quoted from', async () => {
    let resolveMap: (answer: AnchoredTextAnswer) => void = () => {};
    const resourceAnchoredText = vi.fn(
      () => new Promise<AnchoredTextAnswer>((resolve) => { resolveMap = resolve; }),
    );
    const request = vi.fn();
    const session = {
      client: { browse: { resourceAnchoredText }, mark: { request }, beckon: { hover: vi.fn() } },
    } as unknown as SemiontSession;

    renderInEnglish(
      <PdfAnnotationCanvas
        resourceUri={resourceId(String(resourceId('123')))}
        pdfUrl="https://example.com/resources/123.pdf"
        drawingMode="rectangle"
        selectedMotivation="highlighting"
        session={session}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('img[src^="data:image/png"]')).toBeInTheDocument();
    });

    // The page is drawn and the text is not held yet: annotating is off.
    const canvas = document.querySelector('.semiont-pdf-annotation-canvas');
    expect(canvas).toHaveAttribute('data-annotate-deferred', 'true');

    // The late text must not be dropped: an answer after the render is the
    // ordinary sequence. "Hello world" sits on one line at y=700 in PDF
    // points — canvas y=80..92 on this 792pt page.
    await act(async () => {
      resolveMap({
        kind: 'extracted',
        method: 'pdf-text-layer',
        text: 'Hello world\n',
        items: [
          { start: 0, end: 5, page: 1, x: 72, y: 700, width: 30, height: 12 },
          { start: 6, end: 11, page: 1, x: 106, y: 700, width: 32, height: 12 },
        ],
      });
      await new Promise((settled) => setTimeout(settled, 0));
    });

    // The image is still there, annotating is on, and a rectangle drawn now
    // is quoted from the text that arrived after the image.
    expect(canvas).toHaveAttribute('data-annotate-deferred', 'false');
    const img = document.querySelector('img[src^="data:image/png"]') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    Object.defineProperty(img, 'clientWidth', { value: 612, configurable: true });
    Object.defineProperty(img, 'clientHeight', { value: 792, configurable: true });
    fireEvent.load(img);

    const container = document.querySelector('.semiont-pdf-annotation-canvas__container')!;
    fireEvent.mouseDown(container, { clientX: 70, clientY: 78 });
    fireEvent.mouseMove(container, { clientX: 146, clientY: 96 });
    fireEvent.mouseUp(container, { clientX: 146, clientY: 96 });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ type: 'FragmentSelector' }),
      { type: 'TextQuoteSelector', exact: 'Hello world' },
    ]);
  });
});
