/**
 * Text ↔ geometry anchoring for PDFs.
 *
 * Two directions over the same pairing of text and the runs that index it:
 * `locate` turns a character span into rectangles (an annotation the model
 * produced by quoting text), `textUnder` turns a rectangle into characters (an
 * annotation a person produced by dragging a box). They are inverses and live
 * together deliberately.
 *
 * This is pure arithmetic over plain data, so it sits here beside
 * `PdfCoordinate` and the viewrect codec rather than in `@semiont/content`:
 * the browser canvas needs `textUnder` at drag time and cannot import
 * `@semiont/content`, which carries pdf.js, Tesseract and `node:fs`.
 * *Producing* an `AnchoredText` — from a text layer or from OCR — stays there.
 *
 * Coordinates are PDF points with the origin at the bottom-left of the page,
 * Y increasing upward. The Y-flip to canvas pixels lives in the browser.
 */

import type { PdfCoordinate } from './pdf-coordinates';
import type { components } from './types';

/**
 * A single text item (one text run, roughly a word) from a PDF.
 * Character offsets refer to positions in the paired `AnchoredText.text`.
 */
export interface PdfTextItem {
    start: number;  // Char offset in `AnchoredText.text` (inclusive)
    end: number;    // Char offset in `AnchoredText.text` (exclusive)
    page: number;   // 1-indexed page number
    x: number;      // X position in PDF points (origin: bottom-left of page)
    y: number;      // Y position in PDF points (origin: bottom-left of page)
    width: number;
    height: number;
}

/**
 * Text paired with the geometry that indexes it — the minimum needed to turn a
 * character range into a Selection, or a rectangle into a quote.
 *
 * This is the contract `locate`, `textUnder` and the annotation builders
 * actually require; they do not need pages, form fields, or anything else a
 * full `PdfTextLayer` carries. Naming it separately lets OCR'd content
 * (recovered from pixels, so not a "text layer" in the PDF sense) satisfy the
 * same anchoring path.
 */
export interface AnchoredText {
    text: string;
    items: PdfTextItem[];
}

/**
 * The full outcome of text extraction for one representation — the record
 * the anchored-text store holds and the wire serves (PERSIST-ANCHORS
 * decision D1): an `AnchoredText` plus its provenance (`method`, `pdfClass`,
 * `ocrConfidence`, `unreadPages`), or a named decline. `AnchoredText` stays
 * the anchoring vocabulary; this is the stored/served record. Aliased from
 * the generated spec type so the wire shape has exactly one authority.
 */
export type ExtractionOutcome = components['schemas']['ExtractionOutcome'];

/**
 * One text run as pdf.js reports it, narrowed to the fields anchoring reads.
 * Structural on purpose: core takes no dependency on pdfjs-dist, so each
 * producer filters marked-content items at its own boundary and passes the
 * text runs through.
 */
export interface PdfTextRun {
    str: string;
    /** pdf.js text matrix `[a, b, c, d, x, y]`; only x/y are read. */
    transform: number[];
    width: number;
    height: number;
    hasEOL?: boolean;
}

/**
 * pdf.js interleaves marked-content items with text runs in `getTextContent()`;
 * only the latter carry `str`. Both producers filter with this before calling
 * `anchorRuns`, so the boundary rule is stated once.
 */
export function isTextRun<T>(item: T): item is T & PdfTextRun {
    return typeof item === 'object' && item !== null && 'str' in item;
}

/**
 * Turns one page's pdf.js text runs into `AnchoredText`.
 *
 * This is the offset and separator convention — what `text` says, and where
 * each item points into it. Both producers share it: the server extractor
 * reading a whole document, and the browser canvas reading the page under a
 * drag. Divergence would mean the same rectangle quoting differently depending
 * on which side captured it.
 *
 * Offsets are page-local. A caller assembling a multi-page document shifts them
 * by the length of the text already accumulated.
 */
export function anchorRuns(runs: PdfTextRun[], page: number): AnchoredText {
    const items: PdfTextItem[] = [];
    let text = '';

    for (const run of runs) {
        if (run.str.trim()) {
            const start = text.length;
            text += run.str;
            const end = text.length;  // range covers only this run's own chars

            const [, , , , x, y] = run.transform;
            items.push({ start, end, page, x, y, width: run.width, height: run.height });

            // Separator AFTER recording the run, so its [start, end) never
            // includes it. pdf.js flags the last run on a line with hasEOL —
            // newline there, space between words otherwise, so reading-order
            // lines don't glue (e.g. "textsecond").
            text += run.hasEOL ? '\n' : ' ';
        } else if (run.hasEOL) {
            // Standalone end-of-line marker (empty/whitespace str): keep the
            // line break without letting whitespace-only runs add stray spaces.
            text += '\n';
        }
    }

    return { text, items };
}

/**
 * Items whose baseline Y is within this many PDF points are treated as being on
 * the same line. Tuned for ~12pt body text; revisit for documents with large or
 * variable font sizes (Phase 4 / #738).
 */
const SAME_LINE_THRESHOLD_PT = 2;

/**
 * Locates bounding rectangles for a span of text in an AnchoredText
 * (single-line or multi-line).
 *
 * Finds all overlapping items [start, end), groups them by page and line, and
 * records one bounding rectangle per line as a PdfCoordinate.
 *
 * Returns both the per-line `rects` and the `overlap` items they were computed
 * from — so a caller that also needs the covered text (e.g. buildPdfAnnotation's
 * geometry↔text containment invariant) reuses this single `items` scan
 * instead of re-filtering. Both arrays are empty if no item overlaps the span.
 */
export function locate(
    anchored: AnchoredText,
    start: number,
    end: number
): { rects: PdfCoordinate[]; overlap: PdfTextItem[] } {
    const overlap: PdfTextItem[] = anchored.items.filter(
        item => item.start < end && item.end > start
    );
    if (overlap.length === 0) return { rects: [], overlap };

    const pages: Map<number, PdfTextItem[]> = groupItemsByPage(overlap);
    const rects: PdfCoordinate[] = [];

    // for each page, group items into lines and compute one rectangle per line
    for (const [page, pageItems] of pages) {
        const lines = groupItemsByLine(pageItems, SAME_LINE_THRESHOLD_PT);
        // Compute one bounding rectangle per line and add it to rects.
        // Boundary items that extend past [start, end) are clipped by character
        // fraction (PDF-GENERATION P4): renderers like Typst emit ONE item per
        // line, so without clipping a mid-line phrase would bound the whole
        // line. Proportional interpolation is the measured fallback — exact
        // glyph metrics need the operator-list route (open question 2) and can
        // replace this arithmetic without changing the shape.
        for (const lineItems of lines) {
            const edges = lineItems.map(i => {
                const chars = i.end - i.start;
                const left = i.start < start && chars > 0
                    ? i.x + i.width * ((start - i.start) / chars)
                    : i.x;
                const right = i.end > end && chars > 0
                    ? i.x + i.width * ((end - i.start) / chars)
                    : i.x + i.width;
                return { left, right };
            });
            const x = Math.min(...edges.map(e => e.left));
            const right = Math.max(...edges.map(e => e.right));
            const y = Math.min(...lineItems.map(i => i.y));
            const top = Math.max(...lineItems.map(i => i.y + i.height));
            rects.push({page, x, y, width: right - x, height: top - y});
        }
    }
    return { rects, overlap };
}

/**
 * The inverse of `locate`: given a rectangle, returns the text under it.
 *
 * A hand-drawn PDF rectangle otherwise carries no quoted text at all, so every
 * panel that quotes an annotation shows it blank
 * (.plans/PDF-MANUAL-ANNOTATION-TEXT.md).
 *
 * `rect` is in the same PDF-point, bottom-left-origin space as `PdfTextItem`,
 * so a canvas drag rectangle passes straight in. A run counts as covered when
 * the rectangle overlaps `RUN_COVERAGE_THRESHOLD` of its area — see there for
 * why any-intersection is not survivable for a hand-drawn box.
 *
 * Covered runs are emitted in reading order (`text` offset order), which
 * inherits the extractor's known column-major ordering on multi-column pages
 * rather than answering it a second, different way.
 *
 * Returns `''` when nothing is covered — over an image, over whitespace, or
 * over a scanned page with no text layer. Callers must then emit no
 * `TextQuoteSelector` at all: an empty quote would assert the box was drawn
 * around nothing.
 */
export function textUnder(anchored: AnchoredText, rect: PdfCoordinate): string {
    const covered = anchored.items
        .filter(item => item.page === rect.page && covers(item, rect))
        .sort((a, b) => a.start - b.start);
    if (covered.length === 0) return '';

    // Join with the document's own separator when the runs are adjacent in
    // `text` — pdf.js splits words at kerning and font changes, so a blanket
    // join(' ') would emit "aga in" for a single word. When runs are NOT
    // adjacent the rectangle missed the text between them, so substitute a
    // space rather than splicing in words the box does not cover. (Slicing
    // first-offset..last-offset the way buildPdfAnnotation does is safe there
    // — it only feeds a containment check — but here the result is the stored
    // quote, and on a two-column page it would swallow half of each column.)
    let quoted = slice(anchored, covered[0]);
    for (let i = 1; i < covered.length; i++) {
        const gap = anchored.text.slice(covered[i - 1].end, covered[i].start);
        quoted += (gap.trim() === '' ? gap : ' ') + slice(anchored, covered[i]);
    }
    return quoted.trim();
}

const slice = (anchored: AnchoredText, item: PdfTextItem): string =>
    anchored.text.slice(item.start, item.end);

/**
 * Fraction of a run's own area a rectangle must overlap for the run to count
 * as covered.
 *
 * Any intersection — the obvious rule, and `locate`'s rule for offsets — is not
 * survivable here, because a hand-drawn box is not a tight box. What decides
 * the threshold is the *headroom* between lines: word boxes run taller than
 * their glyphs, so the gap between one line's box and the next is far smaller
 * than the visible leading. Exact-quote rate measured over every text page of
 * two real scanned books, by how far the box misses:
 *
 *                      any    0.3    0.4    0.5    0.6
 *   -2pt            98/99  98/83  98/49  60/16   2/ 0
 *   -1pt            98/99  98/100 98/97  98/94  98/84
 *   +2pt            45/ 2  98/97  98/99  98/99  98/100
 *   +4pt            11/ 2  98/16  98/58  98/96  98/97
 *   +6pt             9/ 0  51/ 8  64/11  98/16  98/38
 *          (headroom ~2.0pt / ~0.9pt — the second book is set much tighter,
 *           and on some of its pages adjacent word boxes overlap outright)
 *
 * A third book, 100 pages, varies run granularity instead — ~42 chars per run
 * against 25 and 14, i.e. whole lines as single runs — and 0.5 holds 100% from
 * -1pt to +6pt there. Across all three: >=94% from -1pt to +4pt every time.
 *
 * This also carries page skew, which is why it matters beyond hand-drawn boxes.
 * Tilting real runs and taking axis-aligned boxes after rotation, exact-quote
 * rate: 0.5 holds 100% to 0.25deg and 99% at 0.5deg, where `any` is already at
 * 54% and 34% — a tenth of a degree, invisible to the eye, is enough to wreck
 * it. Beyond ~1deg the limit is not this constant but `SAME_LINE_THRESHOLD_PT`,
 * which a drifting baseline exceeds, splitting one line into several rects.
 *
 * Any-intersection is exact only while the box is tight: 2pt of overshoot —
 * less than the height of a comma, and unavoidable with a mouse — and quotes
 * start picking up fragments of the lines above and below.
 *
 * 0.5 is the widest band holding on BOTH books, about 1pt under to 4pt over.
 * Lower thresholds look better on loosely-set pages and fail on tight ones
 * (0.3 drops to 16% at +4pt on the tighter book), which is exactly the way to
 * overfit this constant to one document. A hand drag overshoots far more often
 * than it undershoots, so the asymmetry is spent on the overshoot side.
 *
 * Consequence to know about: a run the box merely clips — a sliver of the
 * first or last word — falls below the threshold and is dropped. That is the
 * intended trade. Raising this admits neighbouring lines; lowering it drops
 * words from a box drawn slightly small.
 */
export const RUN_COVERAGE_THRESHOLD = 0.5;

function covers(item: PdfTextItem, rect: PdfCoordinate): boolean {
    const overlapX = Math.min(item.x + item.width, rect.x + rect.width) - Math.max(item.x, rect.x);
    const overlapY = Math.min(item.y + item.height, rect.y + rect.height) - Math.max(item.y, rect.y);
    if (overlapX <= 0 || overlapY <= 0) return false;
    return overlapX * overlapY >= RUN_COVERAGE_THRESHOLD * item.width * item.height;
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
