/**
 * Browser PDF.js — bundled from the npm `pdfjs-dist` (v6) package, loaded
 * lazily.
 *
 * pdf.js (the ~300 kB display layer) is pulled in via a dynamic `import()` the
 * first time a PDF is actually opened, so it is code-split out of the main app
 * bundle — restoring the lazy-load behaviour the old CDN loader had. Only the
 * pdf.js *types* are imported statically (erased at build time, zero runtime
 * cost).
 *
 * The worker can't be resolved inside this tsup-built library (Vite's `?url`
 * lives in the app), so the host hands us the worker URL via `setPdfWorkerSrc`
 * once at startup; it is applied to `GlobalWorkerOptions` when pdf.js loads.
 * See `apps/frontend/src/main.tsx`.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

export type { PDFDocumentProxy };

let workerSrc: string | undefined;

/**
 * Supply the (Vite-resolved) pdf.js worker URL. Call once at app startup,
 * before any PDF is opened.
 */
export function setPdfWorkerSrc(src: string): void {
  workerSrc = src;
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | undefined;

/** Lazy-load pdf.js once, applying the worker URL on first load. */
async function getPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((pdfjsLib) => {
      if (workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
      }
      return pdfjsLib;
    });
  }
  return pdfjsPromise;
}

/**
 * Load a PDF document from a URL. The URL must carry auth (e.g. `?token=…`);
 * pdf.js streams the document directly.
 */
export async function loadPdfDocument(url: string): Promise<PDFDocumentProxy> {
  const pdfjsLib = await getPdfjs();
  return pdfjsLib.getDocument({ url }).promise;
}

/**
 * Render a PDF page to a PNG data URL. The `page` is already loaded (its owning
 * document came from `loadPdfDocument`), so no pdf.js import is needed here.
 */
export async function renderPdfPageToDataUrl(
  page: PDFPageProxy,
  scale = 1.0,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  // pdf.js 6 requires the `canvas` parameter; `canvasContext` is deprecated.
  await page.render({ canvas, viewport }).promise;

  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: viewport.width,
    height: viewport.height,
  };
}
