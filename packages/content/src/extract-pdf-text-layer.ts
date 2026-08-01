/**
 * PDF Text Layer Extraction
 *
 * Extracts positioned text from native, non-scanned PDFs using pdfjs-dist.
 * Returns null for scanned/image-only PDFs (no text items).
 *
 * Coordinates are in PDF point space, originating from the bottom-left.
 * The Y-flip to canvas pixels happens downstream.
 */

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfTextLayer, PdfPageInfo, PdfTextItem } from './pdf-text-layer';

export async function extractPdfTextLayer(
    bytes: Uint8Array | Buffer
): Promise<PdfTextLayer | null> {
    // A private copy, for two pdf.js contracts at once: it refuses Node
    // Buffers outright ("provide binary data as Uint8Array"), and it CONSUMES
    // the array it is given — the underlying ArrayBuffer is transferred and
    // detached, which would silently zero the caller's bytes. Callers keep
    // their bytes; pdf.js gets its own.
    const data = new Uint8Array(bytes);
    // pdf.js v5 removed the isEvalSupported option; this path only calls
    // getTextContent (no rendering / no PDF functions).
    const loadingTask = pdfjs.getDocument({ data });

    try {
        // Inside the try so the finally's destroy() also runs when the
        // parse rejects (encrypted/corrupt input — the extractor's decline
        // path classifies that throw).
        const doc = await loadingTask.promise;
        const pages: PdfPageInfo[] = [];
        const items: PdfTextItem[] = [];
        let text = '';
        let hasAnyTextItems = false;

        for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
            const page = await doc.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.0 });
            const content = await page.getTextContent();  // all text items on the page

            pages.push({
                pageNumber: pageNum,
                widthPt: viewport.width,
                heightPt: viewport.height,
            });

            for (const item of content.items) {
                if (!('str' in item)) continue;  // skip marked-content items (no text)

                if (item.str.trim()) {
                    hasAnyTextItems = true;
                    const start = text.length;
                    text += item.str;
                    const end = text.length;  // range covers only this run's own chars

                    const [, , , , x, y] = item.transform as number[];

                    items.push({
                        start,
                        end,
                        page: pageNum,
                        x,
                        y,
                        width: item.width,
                        height: item.height,
                    });

                    // Separator AFTER recording the run, so its [start, end) never
                    // includes it. pdf.js flags the last run on a line with hasEOL —
                    // newline there, space between words otherwise, so reading-order
                    // lines don't glue (e.g. "textsecond").
                    text += item.hasEOL ? '\n' : ' ';
                } else if (item.hasEOL) {
                    // Standalone end-of-line marker (empty/whitespace str): keep the
                    // line break without letting whitespace-only runs add stray spaces.
                    text += '\n';
                }
            }

            text += '\n';  // page break
        }

        if (!hasAnyTextItems) return null;

        return { pages, text, items };
    } finally {
        // Release the pdf.js document — Phase 2 runs this in a long-lived worker
        // pool. pdf.js 6.0 removed PDFDocumentProxy.destroy(); teardown moved to
        // PDFDocumentLoadingTask.destroy().
        await loadingTask.destroy();
    }
}
