/**
 * Tests for the browser pdf.js loader (`browser-pdfjs.ts`).
 *
 * pdf.js is pulled in via a dynamic `import('pdfjs-dist')` the first time a PDF
 * is opened, so it is mocked here. Each test re-imports the module under test
 * after `vi.resetModules()` so the lazy-load memo (`pdfjsPromise`) starts fresh.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';

// Hoisted so the (hoisted) `vi.mock` factory can close over them.
const { getDocumentMock, globalWorkerOptions } = vi.hoisted(() => ({
  getDocumentMock: vi.fn(),
  globalWorkerOptions: { workerSrc: '' } as { workerSrc: string },
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: globalWorkerOptions,
  getDocument: getDocumentMock,
}));

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  getDocumentMock.mockReset();
  globalWorkerOptions.workerSrc = '';
});

describe('loadPdfDocument', () => {
  test('loads the document from the given URL', async () => {
    const fakeDoc = { numPages: 3 };
    getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakeDoc) });

    const { loadPdfDocument } = await import('../browser-pdfjs');
    const url = 'https://example.com/x.pdf?token=abc';
    const doc = await loadPdfDocument(url);

    expect(getDocumentMock).toHaveBeenCalledWith({ url });
    expect(doc).toBe(fakeDoc);
  });

  test('applies the worker URL when setPdfWorkerSrc was called', async () => {
    getDocumentMock.mockReturnValue({ promise: Promise.resolve({}) });

    const { setPdfWorkerSrc, loadPdfDocument } = await import('../browser-pdfjs');
    setPdfWorkerSrc('/assets/pdf.worker.min.mjs');
    await loadPdfDocument('https://example.com/x.pdf');

    expect(globalWorkerOptions.workerSrc).toBe('/assets/pdf.worker.min.mjs');
  });

  test('leaves the worker URL untouched when setPdfWorkerSrc was not called', async () => {
    getDocumentMock.mockReturnValue({ promise: Promise.resolve({}) });

    const { loadPdfDocument } = await import('../browser-pdfjs');
    await loadPdfDocument('https://example.com/x.pdf');

    expect(globalWorkerOptions.workerSrc).toBe('');
  });

  test('imports pdf.js only once across multiple loads (memoized)', async () => {
    getDocumentMock.mockReturnValue({ promise: Promise.resolve({}) });

    const { setPdfWorkerSrc, loadPdfDocument } = await import('../browser-pdfjs');
    setPdfWorkerSrc('first');
    await loadPdfDocument('https://example.com/a.pdf');
    expect(globalWorkerOptions.workerSrc).toBe('first');

    // A second import would re-run the worker-apply step. Clear the slot and
    // change the desired URL; if the loader re-imported, it would write 'second'.
    globalWorkerOptions.workerSrc = '';
    setPdfWorkerSrc('second');
    await loadPdfDocument('https://example.com/b.pdf');

    // Still empty → the worker-apply ran only on the first load.
    expect(globalWorkerOptions.workerSrc).toBe('');
    expect(getDocumentMock).toHaveBeenCalledTimes(2);
  });
});

describe('renderPdfPageToDataUrl', () => {
  function fakePage(): PDFPageProxy {
    return {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 200 * scale,
        height: 100 * scale,
      })),
      render: vi.fn().mockReturnValue({ promise: Promise.resolve(undefined) }),
    } as unknown as PDFPageProxy;
  }

  function stubCanvas(dataUrl: string) {
    const canvas = { width: 0, height: 0, toDataURL: vi.fn().mockReturnValue(dataUrl) };
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement);
    return canvas;
  }

  test('renders a page to a PNG data URL sized to the scaled viewport', async () => {
    const { renderPdfPageToDataUrl } = await import('../browser-pdfjs');
    const page = fakePage();
    const canvas = stubCanvas('data:image/png;base64,XXX');

    const result = await renderPdfPageToDataUrl(page, 2);

    expect(page.getViewport).toHaveBeenCalledWith({ scale: 2 });
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(200);
    expect(page.render).toHaveBeenCalledWith({
      canvas,
      viewport: { width: 400, height: 200 },
    });
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/png');
    expect(result).toEqual({ dataUrl: 'data:image/png;base64,XXX', width: 400, height: 200 });
  });

  test('defaults to scale 1.0', async () => {
    const { renderPdfPageToDataUrl } = await import('../browser-pdfjs');
    const page = fakePage();
    stubCanvas('data:image/png;base64,YYY');

    const result = await renderPdfPageToDataUrl(page);

    expect(page.getViewport).toHaveBeenCalledWith({ scale: 1.0 });
    expect(result).toEqual({ dataUrl: 'data:image/png;base64,YYY', width: 200, height: 100 });
  });
});

describe('setPdfWasmUrl', () => {
  /**
   * pdf.js v6 decodes JPEG 2000 / JBIG2 / ICC through wasm side-files it
   * fetches from `wasmUrl + <fixed filename>` at decode time. The June v4→v6
   * migration wired `workerSrc` but never this, so every JPX object since has
   * failed to decode — and a page holding one wedges on "Dependent image
   * isn't ready yet" (the 1958 REVIEW page-1 blank, diagnosed live
   * 2026-09-13). Same seam shape as the worker: the host resolves the URL,
   * this module hands it to `getDocument`.
   */
  test('passes the configured wasmUrl to getDocument', async () => {
    getDocumentMock.mockReturnValue({ promise: Promise.resolve({}) });

    const { setPdfWasmUrl, loadPdfDocument } = await import('../browser-pdfjs');
    setPdfWasmUrl('/pdfjs/wasm/');
    await loadPdfDocument('https://example.com/x.pdf');

    expect(getDocumentMock).toHaveBeenCalledWith({ url: 'https://example.com/x.pdf', wasmUrl: '/pdfjs/wasm/' });
  });

  test('omits wasmUrl entirely when the host never configured one', async () => {
    getDocumentMock.mockReturnValue({ promise: Promise.resolve({}) });

    const { loadPdfDocument } = await import('../browser-pdfjs');
    await loadPdfDocument('https://example.com/y.pdf');

    // Absent, not defaulted: a manufactured path would 404 into the SPA
    // fallback and turn a config gap into HTML-as-wasm.
    expect(getDocumentMock).toHaveBeenCalledWith({ url: 'https://example.com/y.pdf' });
  });
});
