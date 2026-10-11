/**
 * The page's PIXELS must not wait for its anchored-text map.
 *
 * The load effect starts anchoring and rendering together, and the page
 * appears on its own schedule. Every page of every PDF fetches the map from
 * the server, so were `setPageImageUrl` to sit behind `Promise.all(...)`, a
 * page would show NOTHING until the anchored request resolved. The server
 * holds that request while the Smelter is still reading a document, for as
 * long as fifteen seconds: a blank first page all that time, and not one
 * console error, because a wait is not a failure and nothing reports it.
 *
 * The anchored map is the OPTIONAL half of loading a page; these pin that its
 * latency — up to and including "never" — cannot hold the image.
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

  test('a page shows its image while the anchored-text request is still pending', async () => {
    // The map request HANGS — the server never answers. The image must not care.
    const resourceAnchoredText = vi.fn(() => new Promise(() => { /* never settles */ }));
    const session = {
      client: { browse: { resourceAnchoredText } },
      subscribe: () => () => {},
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
    // The map really was requested — it just could not gate the pixels.
    expect(resourceAnchoredText).toHaveBeenCalled();
  });

  test('the anchored map still lands when it resolves after the image', async () => {
    let resolveMap: (answer: AnchoredTextAnswer) => void = () => {};
    const resourceAnchoredText = vi.fn(
      () => new Promise<AnchoredTextAnswer>((resolve) => { resolveMap = resolve; }),
    );
    const request = vi.fn();
    const session = {
      client: { browse: { resourceAnchoredText }, mark: { request }, beckon: { hover: vi.fn() } },
      subscribe: () => () => {},
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

    // The late map must not be dropped: resolving it after the render is the
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

    // The image is still there, and a rectangle drawn on it now is quoted
    // from the map that arrived after it.
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
