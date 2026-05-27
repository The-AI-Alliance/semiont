/**
* PDF Text Layer Types
*
* Represents the extracted text layer from a native PDF, 
* including per-character geometry in PDF point coordinates 
* originating from the bottom left.
* 
* Note: PdfCoordinate is defined here temporarily. It will move to
* @semiont/core alongside the `FragmentSelector` before Phase 2 (#736),
* so that packages/jobs can serialize viewrects without depending on react-ui.
* Update the import when that refactor lands.
* 
*/


/**
* A bounding rectangle in PDF point coordinates
* Originate from bottom-left of the page; Y increases upward.
* Y-flip to canvas pixels happens elsewhere.
* 
* This should be moved to @semiont/core before Phase 2.
*/
export interface PdfCoordinate {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
* A single text item from the PDF text layer.
* Character offsets refer to positions in `PdfTextLayer.text`.
*/
export interface PdfTextItem {
    start: number;  // Char offset in `PdfTextLayer.text` (inclusive)
    end: number;  // Char offset in `PdfTextLayer.text` (exclusive)
    page: number;  // 1-indexed page number
    x: number;  // X position in PDF points (origin: bottom-left of page) 
    y: number;  // Y position in PDF points (origin: bottom-left of page)
    width: number;
    height: number;
}

/** Page dimensions in PDF points */
export interface PdfPageInfo {
    pageNumber: number;
    widthPt: number;
    heightPt: number;
}

/**
 * The full extracted text layer for a PDF.
 * `text` is the reading-order concatenation across all pages.
 * `items` carry per-character ranges into `text` plus PDF-point geometry
*/
export interface PdfTextLayer {
    pages: PdfPageInfo[];
    text: string;
    items: PdfTextItem[];
}