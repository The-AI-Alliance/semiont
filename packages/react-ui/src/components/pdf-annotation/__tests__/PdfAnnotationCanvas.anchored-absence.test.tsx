/**
 * ANNOTATE-DEFERS-ON-NOT-YET P1: the viewer keeps the wire's three-way absence.
 *
 * `AnchoredTextAnswer` names retryability in the kind itself — `not-yet` means
 * the Smelter has not settled this content generation and the caller should
 * come back; `no-map`, `unknown` and `declined` are definitive. The parent's
 * per-document cache treated ALL of them as definitive, so a scan opened
 * mid-smelt stayed mapless for the whole mount: every annotation drawn on it
 * permanently mute, even after the map landed.
 *
 * Driven through page navigation: each page load asks the parent for the map,
 * so "the cache does not pin `not-yet`" is observable as one ask PER LOAD,
 * and "terminal answers stay cached" as one ask PER MOUNT.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { resourceId } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';

vi.mock('../../../lib/browser-pdfjs', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({
    numPages: 2,
    getPage: vi.fn().mockResolvedValue({
      getViewport: vi.fn().mockReturnValue({ width: 612, height: 792, scale: 1.0, rotation: 0 }),
      // Scanned pages: no text runs, so every page load asks for the map.
      getTextContent: vi.fn().mockResolvedValue({ items: [] }),
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

function sessionAnswering(answer: Record<string, unknown>) {
  const resourceAnchoredText = vi.fn().mockResolvedValue(answer);
  const session = {
    client: { browse: { resourceAnchoredText } },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
  return { session, resourceAnchoredText };
}

async function renderAndVisitBothPages(session: SemiontSession) {
  render(
    <PdfAnnotationCanvas
      resourceUri={String(resourceId('123'))}
      pdfUrl="https://example.com/resources/123.pdf"
      drawingMode={null}
      session={session}
    />,
  );
  const user = userEvent.setup();
  await waitFor(() => expect(vi.mocked(renderPdfPageToDataUrl)).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole('button', { name: /next/i }));
  await waitFor(() => expect(vi.mocked(renderPdfPageToDataUrl)).toHaveBeenCalledTimes(2));
  await user.click(screen.getByRole('button', { name: /previous/i }));
  await waitFor(() => expect(vi.mocked(renderPdfPageToDataUrl)).toHaveBeenCalledTimes(3));
}

describe('PdfAnnotationCanvas — the anchored cache honors retryability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  });
  afterEach(() => vi.unstubAllGlobals());

  test('`not-yet` is never pinned: every page load asks again', async () => {
    const { session, resourceAnchoredText } = sessionAnswering({ kind: 'not-yet' });

    await renderAndVisitBothPages(session);

    // Three page loads, three asks — the RETRY answer must not be cached as
    // a permanent null.
    expect(resourceAnchoredText).toHaveBeenCalledTimes(3);
  });

  test('`no-map` is definitive: one ask per mount', async () => {
    const { session, resourceAnchoredText } = sessionAnswering({ kind: 'no-map' });

    await renderAndVisitBothPages(session);

    expect(resourceAnchoredText).toHaveBeenCalledTimes(1);
  });

  test('a stored decline is definitive: one ask per mount', async () => {
    const { session, resourceAnchoredText } = sessionAnswering({ kind: 'declined', reason: 'no-text-layer' });

    await renderAndVisitBothPages(session);

    expect(resourceAnchoredText).toHaveBeenCalledTimes(1);
  });

  /**
   * P2/D2: Annotate defers on `not-yet` — and ONLY on `not-yet`. An annotation
   * drawn before the map lands is permanently mute (its quote is captured at
   * creation), so waiting buys strictly better annotations. For the terminal
   * absences geometry-only IS the feature, and nothing is deferred.
   */
  describe('Annotate defers on not-yet', () => {
    const root = () => document.querySelector('.semiont-pdf-annotation-canvas');
    const hint = () => screen.queryByRole('status');

    test('`not-yet` masks drawing and shows the hint', async () => {
      const { session } = sessionAnswering({ kind: 'not-yet' });
      render(
        <PdfAnnotationCanvas
          resourceUri={String(resourceId('123'))}
          pdfUrl="https://example.com/resources/123.pdf"
          drawingMode="rectangle"
          session={session}
        />,
      );
      await waitFor(() => expect(vi.mocked(renderPdfPageToDataUrl)).toHaveBeenCalled());

      await waitFor(() => expect(root()).toHaveAttribute('data-annotate-deferred', 'true'));
      expect(hint()).toHaveTextContent(/preparing/i);
    });

    test('`extracted` defers nothing', async () => {
      const { session } = sessionAnswering({ kind: 'extracted', pages: [] });
      render(
        <PdfAnnotationCanvas
          resourceUri={String(resourceId('123'))}
          pdfUrl="https://example.com/resources/123.pdf"
          drawingMode="rectangle"
          session={session}
        />,
      );
      await waitFor(() => expect(vi.mocked(renderPdfPageToDataUrl)).toHaveBeenCalled());

      expect(root()).not.toHaveAttribute('data-annotate-deferred', 'true');
      expect(hint()).not.toBeInTheDocument();
    });

    test('terminal absences stay annotatable, geometry-only, no hint', async () => {
      const { session } = sessionAnswering({ kind: 'no-map' });
      render(
        <PdfAnnotationCanvas
          resourceUri={String(resourceId('123'))}
          pdfUrl="https://example.com/resources/123.pdf"
          drawingMode="rectangle"
          session={session}
        />,
      );
      await waitFor(() => expect(vi.mocked(renderPdfPageToDataUrl)).toHaveBeenCalled());

      expect(root()).not.toHaveAttribute('data-annotate-deferred', 'true');
      expect(hint()).not.toBeInTheDocument();
    });

    test('the flip: a later `extracted` answer enables Annotate without a remount', async () => {
      const resourceAnchoredText = vi.fn()
        .mockResolvedValueOnce({ kind: 'not-yet' })
        .mockResolvedValue({ kind: 'extracted', pages: [] });
      const session = {
    client: { browse: { resourceAnchoredText } },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
      render(
        <PdfAnnotationCanvas
          resourceUri={String(resourceId('123'))}
          pdfUrl="https://example.com/resources/123.pdf"
          drawingMode="rectangle"
          session={session}
        />,
      );
      const user = userEvent.setup();
      await waitFor(() => expect(vi.mocked(renderPdfPageToDataUrl)).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(root()).toHaveAttribute('data-annotate-deferred', 'true'));

      // P1 made `not-yet` re-askable; the next page load gets the map.
      await user.click(screen.getByRole('button', { name: /next/i }));
      await waitFor(() => expect(root()).toHaveAttribute('data-annotate-deferred', 'false'));
      expect(hint()).not.toBeInTheDocument();
    });
  });
});
