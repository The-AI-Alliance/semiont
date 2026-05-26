/**
 * PDF Text Layer Extraction
 * 
 * Extracts positioned text from native, non-scanned PDFs using pdfjs-dist.
 * Returns null for scanned/image-only PDFs.
 * 
 * Coordinates are in PDF point space, originating from bottom-left.
 * Y-flip to canvas pixel happens downstream.
 * 
*/

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfTextLayer, PdfPageInfo, PdfTextItem } from './pdf-text-layer';

export async function extractPdfTextLayer (
    bytes: Uint8Array | Buffer
): Promise<PdfTextLayer | null> {
    const doc = await pdfjs.getDocument({
        data: bytes,
    }).promise;

    const pages: PdfPageInfo[] = [];
    const items: PdfTextItem[] = [];
    let text = '';
    let hasAnyTextItems = false;

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.0 });
        const content = await page.getTextContent();  // fetch all text items on page

        pages.push({
            pageNumber: pageNum,
            widthPt: viewport.viewBox[2],
            heightPt: viewport.viewBox[3],
        });

        for (const item of content.items) {
            if (!('str' in item) || !item.str.trim()) continue;

            hasAnyTextItems = true;
            const start = text.length;
            text += item.str;

            if (!item.hasEOL) text += ' ';  // add space between words
            const end = text.length;  // offset

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
        }

        text += '\n';
    }

    if (!hasAnyTextItems) return null;

    return { pages, text, items };
}