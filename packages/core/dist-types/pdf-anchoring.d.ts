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
    start: number;
    end: number;
    page: number;
    x: number;
    y: number;
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
 * What a READER gets when it asks for a resource's map: the map, a stored
 * decline, or a named absence (SMELTER-OWNS-OCR P1).
 *
 * Deliberately wider than `ExtractionOutcome`, which is what the store HOLDS and
 * what an extractor RETURNS — neither of which can ever be "not yet". Widening
 * that type instead would have put an impossible state into the store's own.
 */
export type AnchoredTextAnswer = components['schemas']['AnchoredTextAnswer'];
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
export declare function isTextRun<T>(item: T): item is T & PdfTextRun;
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
export declare function anchorRuns(runs: PdfTextRun[], page: number): AnchoredText;
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
export declare function locate(anchored: AnchoredText, start: number, end: number): {
    rects: PdfCoordinate[];
    overlap: PdfTextItem[];
};
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
export declare function textUnder(anchored: AnchoredText, rect: PdfCoordinate): string;
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
export declare const RUN_COVERAGE_THRESHOLD = 0.5;
