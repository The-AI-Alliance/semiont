/**
 * OCR word boxes → PDF-point geometry (#739).
 *
 * OCR reports boxes in the image's own pixel space, top-left origin. Anchoring
 * them means going through the matrix that placed the image on the page:
 *
 *     pixel (px, py) → unit square (px/W, 1 − py/H) → CTM → PDF points
 *
 * Rotation and non-uniform scale fall out of the matrix, so there are no
 * special cases for them — the only explicit work is normalizing the result,
 * since a mirrored placement can invert an axis and consumers bound
 * rectangles rather than orienting them.
 */

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { OcrWord } from './ocr';
import type { PdfTextItem } from '@semiont/core';

/** The placement of one image: its pixel size and its matrix onto the page. */
export interface ImagePlacement {
    width: number;
    height: number;
    ctm: number[];
}

function toPagePoint(px: number, py: number, placement: ImagePlacement): [number, number] {
    // Unit square, Y flipped: pixel rows run down, PDF space runs up.
    const point: [number, number] = [px / placement.width, 1 - py / placement.height];
    pdfjs.Util.applyTransform(point, placement.ctm);   // mutates in place
    return point;
}

/**
 * Map recognized words onto the page, shifting their character offsets by
 * `textOffset` — where this page's text begins in the assembled document.
 */
export function mapWordsToItems(
    words: OcrWord[],
    placement: ImagePlacement,
    page: number,
    textOffset: number,
): PdfTextItem[] {
    if (placement.width <= 0 || placement.height <= 0) return [];

    return words.map((word) => {
        // Both corners through the matrix, then bound them — a flipped or
        // rotated placement can put either one first.
        const [ax, ay] = toPagePoint(word.bbox.x0, word.bbox.y0, placement);
        const [bx, by] = toPagePoint(word.bbox.x1, word.bbox.y1, placement);
        const x = Math.min(ax, bx);
        const y = Math.min(ay, by);
        return {
            start: word.start + textOffset,
            end: word.end + textOffset,
            page,
            x,
            y,
            width: Math.abs(bx - ax),
            height: Math.abs(by - ay),
        };
    });
}
