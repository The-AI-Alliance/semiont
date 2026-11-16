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
import { STANDARD_FONT_DATA_URL } from './pdfjs-assets';
import { isObject, isString, isNumber, isArray, anchorRuns, isTextRun, type PdfTextItem } from '@semiont/core';
import type { PdfTextLayer, PdfPageInfo, PdfFormField } from './pdf-text-layer';

/**
 * One entry from pdf.js's `getFieldObjects()` map, narrowed to a filled
 * field. The API types entries as bare `Object`, so every field is checked:
 * group entries (a parent with `kidIds`) carry `page: -1` and no value and
 * are rejected here, leaving the widgets that actually hold content.
 */
function toFormField(entry: unknown): PdfFormField | null {
    if (!isObject(entry)) return null;
    const { name, value, page, rect } = entry;
    if (!isString(name) || !isString(value) || !value.trim()) return null;
    if (!isNumber(page) || page < 0) return null;
    if (!isArray(rect) || rect.length < 4 || !rect.every(isNumber)) return null;
    const [x1, y1, x2, y2] = rect as [number, number, number, number];
    return {
        name,
        value: value.trim(),
        page: page + 1,              // pdf.js reports 0-indexed; PdfTextItem is 1-indexed
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
    };
}

/**
 * Filled AcroForm values, one per field name (first filled widget wins, so a
 * radio group contributes a single answer). Returns [] for a document with
 * no form. XFA forms are out of scope: whatever their AcroForm shell exposes
 * is read the same way, and anything else simply yields no fields.
 */
async function readFormFields(doc: pdfjs.PDFDocumentProxy): Promise<PdfFormField[]> {
    const fieldObjects = await doc.getFieldObjects();
    if (!fieldObjects) return [];
    const byName = new Map<string, PdfFormField>();
    for (const entries of Object.values(fieldObjects)) {
        if (!isArray(entries)) continue;
        for (const entry of entries) {
            const field = toFormField(entry);
            if (field && !byName.has(field.name)) byName.set(field.name, field);
        }
    }
    return [...byName.values()];
}

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
    const loadingTask = pdfjs.getDocument({ data, standardFontDataUrl: STANDARD_FONT_DATA_URL });

    try {
        // Inside the try so the finally's destroy() also runs when the
        // parse rejects (encrypted/corrupt input — the extractor's decline
        // path classifies that throw).
        const doc = await loadingTask.promise;
        const pages: PdfPageInfo[] = [];
        const items: PdfTextItem[] = [];
        let text = '';

        for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
            const page = await doc.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.0 });
            const content = await page.getTextContent();  // all text items on the page
            const pageTextStart = text.length;

            // `anchorRuns` owns the offset and separator convention; the
            // browser canvas builds its page the same way, so a rectangle
            // quotes identically whichever side captured it. Marked-content
            // items (no `str`) are filtered here, at the pdf.js boundary —
            // core stays free of pdfjs-dist.
            const page1 = anchorRuns(content.items.filter(isTextRun), pageNum);

            // Offsets come back page-local; shift them into the document text.
            for (const item of page1.items) {
                items.push({ ...item, start: item.start + pageTextStart, end: item.end + pageTextStart });
            }
            text += page1.text;
            text += '\n';  // page break

            pages.push({
                pageNumber: pageNum,
                widthPt: viewport.width,
                heightPt: viewport.height,
                textStart: pageTextStart,
                textEnd: text.length,
                hasTextLayer: page1.items.length > 0,
            });
        }

        // A document with no drawn text is a scanned page (class B) even when
        // it carries an AcroForm — form values augment a text layer, they do
        // not substitute for one. Keeping this condition on text items alone
        // also keeps the reader's null contract stable for detection.
        if (!pages.some((page) => page.hasTextLayer)) return null;

        return { pages, text, items, fields: await readFormFields(doc) };
    } finally {
        // Release the pdf.js document — Phase 2 runs this in a long-lived worker
        // pool. pdf.js 6.0 removed PDFDocumentProxy.destroy(); teardown moved to
        // PDFDocumentLoadingTask.destroy().
        await loadingTask.destroy();
    }
}
