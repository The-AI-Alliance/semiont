/**
 * Embedded page images — the pixel path OCR reads (Phase 3).
 *
 * This is the dependency-free half, tested for real: no canvas, no
 * rasterizer, just pdf.js decoding the embedded image in its worker.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { describe, it, expect } from 'vitest';
import { extractPageImages, toRgb } from '../pdf-page-images';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

describe('extractPageImages', () => {
    it('returns the embedded scan as a PNG, at its own resolution', async () => {
        const byPage = await extractPageImages(readFixture('scanned-image.pdf'));
        const images = byPage.get(1);
        expect(images).toHaveLength(1);
        expect(images![0]!.png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
        // IHDR width/height are big-endian at fixed offsets — the fixture's
        // raster is 240x140, and extracting (not rendering) preserves it.
        expect(images![0]!.png.readUInt32BE(16)).toBe(240);
        expect(images![0]!.png.readUInt32BE(20)).toBe(140);
    });

    it('extracts only the requested pages', async () => {
        const byPage = await extractPageImages(readFixture('mixed.pdf'), [2]);
        expect([...byPage.keys()]).toEqual([2]);
        expect(byPage.get(2)).toHaveLength(1);
    });

    it('reports no images for a page that has none', async () => {
        // Page 1 of the mixed fixture is native text — nothing to OCR.
        const byPage = await extractPageImages(readFixture('mixed.pdf'), [1]);
        expect(byPage.size).toBe(0);
    });

    it('is empty for a document with no images at all', async () => {
        const byPage = await extractPageImages(readFixture('single-line.pdf'));
        expect(byPage.size).toBe(0);
    });

    // An image used by more than one page is promoted to pdf.js's GLOBAL
    // scope: page 1 resolves `img_p0_1` from `page.objs`, page 2 resolves
    // `g_d1_img_p1_1` from `page.commonObjs`. Asking `page.objs` for a global
    // object never invokes the callback — so this hung forever rather than
    // failing, in a path the smelter and the detection worker both await, and
    // a worker that will not claim another job while one is active.
    //
    // The explicit timeout is the point: without it a regression re-hangs the
    // suite instead of reporting.
    it('reads an image shared across pages', { timeout: 20_000 }, async () => {
        const byPage = await extractPageImages(readFixture('shared-image.pdf'));
        expect([...byPage.keys()].sort()).toEqual([1, 2]);
        expect(byPage.get(2)).toHaveLength(1);
        expect(byPage.get(2)![0]!.png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    });
});

/**
 * The sample buffer pdf.js hands back is NOT always a `Uint8Array`.
 *
 * JPEG (`/DCTDecode`) images — which is what essentially every real scanned
 * PDF uses — decode to a `Uint8ClampedArray`, and `Uint8ClampedArray` is not
 * an instance of `Uint8Array`. A guard that tests only for `Uint8Array`
 * therefore discards real scans while accepting every fixture in this repo,
 * all of which are `/FlateDecode` and decode to a plain `Uint8Array`.
 *
 * The failure is silent and reads as success: no image means no OCR, which
 * surfaces as `declined: 'no-text-layer'` (class B) or `unreadPages` (class C)
 * — indistinguishable from "OCR ran and found nothing". Measured on a real
 * 28-page scanned book: 0 of 3 image-only pages recovered, in 0.3s.
 *
 * Both views index bytes identically, so both are accepted. These cases pin
 * that; the fixture-driven tests above cover the `Uint8Array` side.
 */
describe('toRgb — accepts either byte view pdf.js may deliver', () => {
    const GRAYSCALE_1BPP = 1, RGB_24BPP = 2, RGBA_32BPP = 3;

    it('accepts RGB samples as a Uint8ClampedArray (the /DCTDecode shape)', () => {
        const data = new Uint8ClampedArray([255, 0, 0, 0, 255, 0]);   // 2x1 red, green
        const out = toRgb({ width: 2, height: 1, kind: RGB_24BPP, data });
        expect(out).not.toBeNull();
        expect(Array.from(out!.rgb)).toEqual([255, 0, 0, 0, 255, 0]);
    });

    it('accepts RGBA samples as a Uint8ClampedArray, dropping alpha', () => {
        const data = new Uint8ClampedArray([255, 0, 0, 128, 0, 255, 0, 255]);
        const out = toRgb({ width: 2, height: 1, kind: RGBA_32BPP, data });
        expect(out).not.toBeNull();
        expect(Array.from(out!.rgb)).toEqual([255, 0, 0, 0, 255, 0]);
    });

    it('accepts packed bilevel samples as a Uint8ClampedArray', () => {
        // One row, 8 px: 0b10000000 — first pixel white (set bit), rest black.
        const out = toRgb({ width: 8, height: 1, kind: GRAYSCALE_1BPP, data: new Uint8ClampedArray([0x80]) });
        expect(out).not.toBeNull();
        expect(Array.from(out!.rgb.subarray(0, 6))).toEqual([255, 255, 255, 0, 0, 0]);
    });

    it('still accepts a plain Uint8Array', () => {
        const out = toRgb({ width: 2, height: 1, kind: RGB_24BPP, data: new Uint8Array([1, 2, 3, 4, 5, 6]) });
        expect(Array.from(out!.rgb)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('still rejects a kind it cannot read, and a short buffer', () => {
        expect(toRgb({ width: 2, height: 1, kind: 99, data: new Uint8Array(6) })).toBeNull();
        expect(toRgb({ width: 2, height: 1, kind: RGB_24BPP, data: new Uint8ClampedArray(3) })).toBeNull();
    });
});
