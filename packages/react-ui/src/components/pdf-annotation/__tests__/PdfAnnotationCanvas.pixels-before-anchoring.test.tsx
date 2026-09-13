/**
 * The page's PIXELS must not wait for its anchored-text map.
 *
 * The load effect starts anchoring and rendering together, and its own comment
 * promises "the page appears on its own schedule" — but `setPageImageUrl` sat
 * behind `Promise.all(...)`, so a scanned page (no text runs — the one kind
 * that fetches its map from the server) showed NOTHING until the anchored
 * request resolved. On a stack where that bus request times out, that is the
 * full 30s B14 window with a blank first page and not one console error:
 * anchoring "never rejects" by design, so nothing ever reported the wait.
 *
 * Diagnosed live 2026-09-13 on a 52-page scan whose page 1 appeared after
 * ~40s. The anchored map is the OPTIONAL half of loading a page; these pin
 * that its latency — up to and including "never" — cannot hold the image.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { resourceId } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';

vi.mock('../../../lib/browser-pdfjs', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({
    numPages: 2,
    getPage: vi.fn().mockResolvedValue({
      getViewport: vi.fn().mockReturnValue({ width: 612, height: 792, scale: 1.0, rotation: 0 }),
      // A scanned page: the characters exist only as pixels, so the component
      // goes to the server for its map — the path under test.
      getTextContent: vi.fn().mockResolvedValue({ items: [] }),
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

  test('a scanned page shows its image while the anchored-text request is still pending', async () => {
    // The map request HANGS — the server never answers. The image must not care.
    const resourceAnchoredText = vi.fn(() => new Promise(() => { /* never settles */ }));
    const session = {
      client: { browse: { resourceAnchoredText } },
      subscribe: () => () => {},
    } as unknown as SemiontSession;

    render(
      <PdfAnnotationCanvas
        resourceUri={String(resourceId('123'))}
        pdfUrl="https://example.com/resources/123.pdf"
        drawingMode={null}
        session={session}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('img[src^="data:image/png"]')).toBeInTheDocument();
    });
    // The scanned path really was exercised: the map was requested — it just
    // could not gate the pixels.
    expect(resourceAnchoredText).toHaveBeenCalled();
  });

  test('the anchored map still lands when it resolves after the image', async () => {
    let resolveMap: (v: unknown) => void = () => {};
    const resourceAnchoredText = vi.fn(() => new Promise((r) => { resolveMap = r; }));
    const session = {
      client: { browse: { resourceAnchoredText } },
      subscribe: () => () => {},
    } as unknown as SemiontSession;

    render(
      <PdfAnnotationCanvas
        resourceUri={String(resourceId('123'))}
        pdfUrl="https://example.com/resources/123.pdf"
        drawingMode={null}
        session={session}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('img[src^="data:image/png"]')).toBeInTheDocument();
    });

    // The late map must not be dropped: resolving it after the render is the
    // ordinary sequence now, and it must not throw or unmount the image.
    resolveMap(null);
    await waitFor(() => {
      expect(document.querySelector('img[src^="data:image/png"]')).toBeInTheDocument();
    });
  });
});
