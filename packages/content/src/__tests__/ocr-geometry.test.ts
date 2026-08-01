/**
 * OCR word boxes → PDF points (#739).
 *
 * Pixel space is top-left origin; PDF space is bottom-left. The composition is
 * pixel → unit square → placement matrix, so rotation and non-uniform scale
 * fall out of the matrix instead of needing cases.
 */

import { describe, it, expect } from 'vitest';
import { mapWordsToItems } from '../ocr-geometry';
import type { OcrWord } from '../ocr';

const word = (text: string, bbox: { x0: number; y0: number; x1: number; y1: number }, start = 0): OcrWord =>
    ({ text, start, end: start + text.length, bbox, confidence: 90 });

/** A 100×100 image covering a 612×792 page. */
const fullPage = { width: 100, height: 100, ctm: [612, 0, 0, 792, 0, 0] };

describe('mapWordsToItems', () => {
    it('flips the Y axis — a word at the top of the image is high on the page', () => {
        const [item] = mapWordsToItems([word('top', { x0: 0, y0: 0, x1: 50, y1: 50 })], fullPage, 1, 0);
        expect(item).toMatchObject({ page: 1, x: 0, y: 396, width: 306, height: 396 });
    });

    it('places a bottom-right word at the bottom right of the page', () => {
        const [item] = mapWordsToItems([word('end', { x0: 50, y0: 50, x1: 100, y1: 100 })], fullPage, 1, 0);
        expect(item).toMatchObject({ x: 306, y: 0, width: 306, height: 396 });
    });

    it('honors an off-origin scaled placement', () => {
        // The image sits at (100, 200) sized 300×400 — the whole image maps
        // onto exactly that rectangle.
        const placed = { width: 100, height: 100, ctm: [300, 0, 0, 400, 100, 200] };
        const [item] = mapWordsToItems([word('all', { x0: 0, y0: 0, x1: 100, y1: 100 })], placed, 2, 0);
        expect(item).toMatchObject({ page: 2, x: 100, y: 200, width: 300, height: 400 });
    });

    it('shifts character offsets by where the page landed in the document', () => {
        const items = mapWordsToItems(
            [word('alpha', { x0: 0, y0: 0, x1: 10, y1: 10 }, 0), word('beta', { x0: 20, y0: 0, x1: 30, y1: 10 }, 6)],
            fullPage,
            1,
            1000,
        );
        expect(items.map((i) => [i.start, i.end])).toEqual([[1000, 1005], [1006, 1010]]);
    });

    it('produces a normalized rectangle even when the matrix flips an axis', () => {
        // A negative Y scale (mirrored placement) must still yield a positive
        // width and height — consumers bound rects, they do not orient them.
        const mirrored = { width: 100, height: 100, ctm: [612, 0, 0, -792, 0, 792] };
        const [item] = mapWordsToItems([word('x', { x0: 0, y0: 0, x1: 50, y1: 50 })], mirrored, 1, 0);
        expect(item!.width).toBeGreaterThan(0);
        expect(item!.height).toBeGreaterThan(0);
    });
});
