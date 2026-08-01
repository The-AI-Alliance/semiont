/**
 * Placement transform — where a page's image actually sits (#739).
 *
 * OCR returns boxes in image-pixel space; anchoring them needs the matrix
 * that placed the image on the page. Two things are tested separately here
 * because a fixture cannot check both: `findPlacedImages` composes nested
 * transforms in the right ORDER (needs two non-identity matrices, which
 * pdf-lib never emits), and the fixtures check the composition produces the
 * right ANSWER end to end.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { describe, it, expect } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageImages, findPlacedImages } from '../pdf-page-images';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));

describe('findPlacedImages — composition order', () => {
    const { OPS } = pdfjs;

    it('composes nested transforms so the innermost applies to the point first', () => {
        // Outer: scale by 2. Inner: translate by (10, 20). A point at the
        // image's unit origin must land at (20, 40) — the translation scaled by
        // the enclosing matrix — NOT at (10, 20), which is what the reversed
        // order would give.
        const placed = findPlacedImages(
            [OPS.save, OPS.transform, OPS.transform, OPS.paintImageXObject, OPS.restore],
            [[], [2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 10, 20], ['img', 8, 8], []],
        );
        expect(placed).toHaveLength(1);
        expect(placed[0]!.ctm).toEqual([2, 0, 0, 2, 20, 40]);
    });

    it('restores the matrix saved before a nested transform', () => {
        const placed = findPlacedImages(
            [OPS.save, OPS.transform, OPS.restore, OPS.paintImageXObject],
            [[], [5, 0, 0, 5, 0, 0], [], ['img', 8, 8]],
        );
        // The transform was scoped to the save/restore pair, so the image is
        // painted under the identity matrix.
        expect(placed[0]!.ctm).toEqual([1, 0, 0, 1, 0, 0]);
    });

    it('carries the image reference and its pixel dimensions', () => {
        const placed = findPlacedImages([OPS.paintImageXObject], [['img_p0_1', 240, 140]]);
        expect(placed[0]).toMatchObject({ ref: 'img_p0_1', width: 240, height: 140 });
    });
});

describe('extractPageImages — placement end to end', () => {
    it('reports a full-page scan as the page-sized matrix', async () => {
        const byPage = await extractPageImages(readFixture('scanned-image.pdf'));
        const image = byPage.get(1)![0]!;
        expect(image.ctm).toEqual([612, 0, 0, 792, 0, 0]);
        expect(image.width).toBe(240);
        expect(image.height).toBe(140);
    });

    it('reports an off-origin scaled scan at its actual position', async () => {
        const byPage = await extractPageImages(readFixture('scanned-placed.pdf'));
        const image = byPage.get(1)![0]!;
        // Drawn at (100, 200), 300×400 — the unit square maps onto exactly that.
        expect(image.ctm).toEqual([300, 0, 0, 400, 100, 200]);
    });
});
