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
import { extractPageImages } from '../pdf-page-images';

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
});
