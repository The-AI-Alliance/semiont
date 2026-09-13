/**
 * ANNOTATE-DEFERS-ON-NOT-YET P4, the PULL half: a `not-yet` answer schedules a
 * bounded re-ask (5s → 15s → 45s, then held at 45s), so the deferred state
 * self-heals even before `smelt:settled` is bridged — and keeps healing after
 * a missed broadcast once it is.
 *
 * The flip must reach the MOUNTED page: the map is captured per page at load,
 * so a retry that lands `extracted` re-resolves the open page (the epoch).
 * Without that, the gate would open onto a page still holding no map, and the
 * first annotation drawn after the flip would be permanently mute — the exact
 * annotation D2 exists to protect.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { resourceId } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';

vi.mock('../../../lib/browser-pdfjs', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({
    numPages: 2,
    getPage: vi.fn().mockResolvedValue({
      getViewport: vi.fn().mockReturnValue({ width: 612, height: 792, scale: 1.0, rotation: 0 }),
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

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const root = () => document.querySelector('.semiont-pdf-annotation-canvas');

function mount(resourceAnchoredText: ReturnType<typeof vi.fn>) {
  const session = { client: { browse: { resourceAnchoredText } } } as unknown as SemiontSession;
  return render(
    <PdfAnnotationCanvas
      resourceUri={String(resourceId('123'))}
      pdfUrl="https://example.com/resources/123.pdf"
      drawingMode="rectangle"
      session={session}
    />,
  );
}

describe('PdfAnnotationCanvas — bounded retry on not-yet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('climbs the ladder while not-yet persists, and holds at the top', async () => {
    const ask = vi.fn().mockResolvedValue({ kind: 'not-yet' });
    mount(ask);
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);        // the page load's ask

    await advance(5_000);
    expect(ask).toHaveBeenCalledTimes(2);        // +5s
    await advance(15_000);
    expect(ask).toHaveBeenCalledTimes(3);        // +15s
    await advance(45_000);
    expect(ask).toHaveBeenCalledTimes(4);        // +45s
    await advance(45_000);
    expect(ask).toHaveBeenCalledTimes(5);        // held at 45s, no runaway
  });

  test('a retry that lands the map flips the gate AND re-resolves the mounted page', async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce({ kind: 'not-yet' })
      .mockResolvedValue({ kind: 'extracted', pages: [] });
    mount(ask);
    await flush();
    expect(root()).toHaveAttribute('data-annotate-deferred', 'true');

    await advance(5_000);

    expect(root()).toHaveAttribute('data-annotate-deferred', 'false');
    // The open page went back for its map: the epoch re-ran its load (a
    // second page render), and the re-resolve is served from the now-warm
    // cache — the retry's `extracted` is terminal, so NO third wire ask.
    await flush();
    expect(vi.mocked(renderPdfPageToDataUrl).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(ask).toHaveBeenCalledTimes(2);
    // And the retrying stopped: the map is definitive.
    await advance(120_000);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  test('terminal answers never schedule a retry', async () => {
    const ask = vi.fn().mockResolvedValue({ kind: 'no-map' });
    mount(ask);
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);

    await advance(300_000);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  test('unmount cancels the pending retry', async () => {
    const ask = vi.fn().mockResolvedValue({ kind: 'not-yet' });
    const { unmount } = mount(ask);
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);

    unmount();
    await advance(300_000);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
