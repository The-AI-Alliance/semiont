import type { PdfCoordinate } from '@semiont/core';
import type { PdfTextLayer, PdfTextItem } from './pdf-text-layer';

/**
 * Items whose baseline Y is within this many PDF points are treated as being on
 * the same line. Tuned for ~12pt body text; revisit for documents with large or
 * variable font sizes (Phase 4 / #738).
 */
const SAME_LINE_THRESHOLD_PT = 2;

/**
 * Locates bounding rectangles for a span of text in a PdfTextLayer
 * (single-line or multi-line).
 *
 * Finds all overlapping items [start, end), groups them by page and line, and
 * records one bounding rectangle per line as a PdfCoordinate.
 *
 * Returns both the per-line `rects` and the `overlap` items they were computed
 * from — so a caller that also needs the covered text (e.g. buildPdfAnnotation's
 * geometry↔text containment invariant) reuses this single `layer.items` scan
 * instead of re-filtering. Both arrays are empty if no item overlaps the span.
 */
export function locate(
    layer: PdfTextLayer,
    start: number,
    end: number
): { rects: PdfCoordinate[]; overlap: PdfTextItem[] } {
    const overlap: PdfTextItem[] = layer.items.filter(
        item => item.start < end && item.end > start
    );
    if (overlap.length === 0) return { rects: [], overlap };

    const pages: Map<number, PdfTextItem[]> = groupItemsByPage(overlap);
    const rects: PdfCoordinate[] = [];

    // for each page, group items into lines and compute one rectangle per line
    for (const [page, pageItems] of pages) {
        const lines = groupItemsByLine(pageItems, SAME_LINE_THRESHOLD_PT);
        // Compute one bounding rectangle per line and add it to rects
        for (const lineItems of lines) {
            const x = Math.min(...lineItems.map(i => i.x));
            const right = Math.max(...lineItems.map(i => i.x + i.width));
            const y = Math.min(...lineItems.map(i => i.y));
            const top = Math.max(...lineItems.map(i => i.y + i.height));
            rects.push({page, x, y, width: right - x, height: top - y});
        }
    }
    return { rects, overlap };
}

function groupItemsByPage(items: PdfTextItem[]): Map<number, PdfTextItem[]> {
    const map = new Map<number, PdfTextItem[]>();
    for (const item of items) {
        const existing = map.get(item.page);
        if (existing) {
            existing.push(item);
        } else {
            map.set(item.page, [item]);
        }
    }
    return map;
}


/**
 * Sorts text items into lines when their y coordinates are
 * within `sameLineThreshold` points of each other.
 * Sorted top-to-bottom (descending y in PDF space), then left-to-right.
 * 
 * Returns 2D array: 
 * Outer array = list of lines
 * Inner array = list of items on that line
*/
function groupItemsByLine(items: PdfTextItem[], sameLineThreshold: number): PdfTextItem[][] {
    // Sort top-to-bottom by y; if y is equal, sort left-to-right by x
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: PdfTextItem[][] = [];
    let currentLine: PdfTextItem[] = [];

    for (const item of sorted) {
        if (currentLine.length === 0 || Math.abs(item.y - currentLine[0].y) <= sameLineThreshold) {
            currentLine.push(item);
        } else {
            lines.push(currentLine);
            currentLine = [item];
        }
    }
    if (currentLine.length > 0) lines.push(currentLine);
    return lines;
}
