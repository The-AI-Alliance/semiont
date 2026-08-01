/**
 * PDF Text Layer Types
 *
 * Represents the extracted text layer from a native PDF, including per-run (word-level)
 * geometry in PDF point coordinates originating from the bottom-left of the page
 * (Y increases upward). The Y-flip to canvas pixels happens downstream in the
 * browser; the server has no canvas.
 *
 * `PdfCoordinate` — the geometry `locate()` emits — lives in `@semiont/core`
 * alongside the viewrect FragmentSelector codec.
 */

/**
 * A single text item (one text run, roughly a word) from the PDF text layer.
 * Character offsets refer to positions in `PdfTextLayer.text`.
 */
export interface PdfTextItem {
    start: number;  // Char offset in `PdfTextLayer.text` (inclusive)
    end: number;    // Char offset in `PdfTextLayer.text` (exclusive)
    page: number;   // 1-indexed page number
    x: number;      // X position in PDF points (origin: bottom-left of page)
    y: number;      // Y position in PDF points (origin: bottom-left of page)
    width: number;
    height: number;
}

/**
 * One filled AcroForm field: the value a form carries outside its drawn text
 * layer. Geometry is the widget's rectangle, in the same PDF-point,
 * bottom-left-origin space as `PdfTextItem` — so a consumer that folds field
 * values into text can anchor them like any other run.
 */
export interface PdfFormField {
    name: string;
    value: string;
    page: number;   // 1-indexed, matching PdfTextItem
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Page dimensions in PDF points, plus the page's span of `PdfTextLayer.text` */
export interface PdfPageInfo {
    pageNumber: number;
    widthPt: number;
    heightPt: number;
    textStart: number;  // Char offset in `PdfTextLayer.text` (inclusive)
    textEnd: number;    // Char offset in `PdfTextLayer.text` (exclusive)
    /**
     * Whether this page carries text-showing operators. False means the page
     * is scanned: its characters exist only as pixels, so reading it needs
     * OCR rather than `getTextContent`. Per-PAGE, deliberately: a document
     * mixing native and scanned pages (class C) must route each page
     * separately, and a single document-level flag cannot express that.
     */
    hasTextLayer: boolean;
}

/**
 * Text paired with the geometry that indexes it — the minimum needed to turn a
 * character range into a Selection.
 *
 * This is the contract `locate()` and the annotation builders actually require;
 * they do not need pages, form fields, or anything else a full layer carries.
 * Naming it separately lets OCR'd content (recovered from pixels, so not a
 * "text layer" in the PDF sense) satisfy the same anchoring path.
 */
export interface AnchoredText {
    text: string;
    items: PdfTextItem[];
}

/**
 * The full extracted text layer for a PDF.
 * `text` is the reading-order concatenation across all pages.
 * Each `item` is one text run carrying its character range into `text` plus PDF-point geometry.
 */
export interface PdfTextLayer extends AnchoredText {
    pages: PdfPageInfo[];
    /**
     * Filled AcroForm field values, empty for a document without a form.
     * Deliberately NOT folded into `text`: the reader reports what the
     * document holds, and each consumer projects what it needs — detection
     * reads `text`/`items` and is unaffected by a form's presence, while the
     * embedding extractor folds these in (SMELTER-MEDIA-TYPES class E).
     */
    fields: PdfFormField[];
}
