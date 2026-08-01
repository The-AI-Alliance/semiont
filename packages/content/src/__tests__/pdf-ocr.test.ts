/**
 * OCR integration — classes B and C become readable (Phase 3).
 *
 * The engine is stubbed here so the MERGE is what gets asserted:
 * deterministic, and independent of how well tesseract reads a given scan.
 * OCR *quality* is not a unit-test question — the fixtures are synthetic
 * rasters with no real glyphs, and judging accuracy needs real scans, which
 * is the live tier's job. What must hold here is that recognized text lands
 * in the right document, in the right class, and clears the unread-page gap.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EXTRACTORS } from '../content-extractor';
import { recognizeImages } from '../ocr';

vi.mock('../ocr', () => ({ recognizeImages: vi.fn() }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));

const extract = (fixture: string) =>
    EXTRACTORS['pdf-text-layer']!.extract(readFixture(fixture), 'application/pdf');

/** Every image recognizes as the same known text. */
const recognizesAs = (text: string) => {
    vi.mocked(recognizeImages).mockImplementation(async (images = []) => images.map(() => text));
};

describe('class B — a fully scanned document', () => {
    beforeEach(() => vi.mocked(recognizeImages).mockReset());

    it('is read by OCR instead of declined', async () => {
        recognizesAs('RECOVERED FROM THE SCAN');
        const out = await extract('scanned-image.pdf');
        if ('declined' in out) throw new Error(`unexpected decline: ${out.declined}`);
        expect(out.text).toContain('RECOVERED FROM THE SCAN');
        expect(out.pdfClass).toBe('B');
        expect(out.method).toBe('ocr');
        expect(out.unreadPages).toBeUndefined();
    });

    it("declines 'no-text-layer' when OCR finds nothing — now meaning it truly failed", async () => {
        recognizesAs('');
        expect(await extract('scanned-image.pdf')).toEqual({ declined: 'no-text-layer' });
    });

    it('declines when the page holds no image to read', async () => {
        recognizesAs('should never be reached');
        // The degenerate scan: an empty page, no pixels at all.
        expect(await extract('scanned.pdf')).toEqual({ declined: 'no-text-layer' });
        expect(recognizeImages).not.toHaveBeenCalled();
    });
});

describe('class C — a hybrid document', () => {
    beforeEach(() => vi.mocked(recognizeImages).mockReset());

    it('keeps its native text and gains the scanned page', async () => {
        recognizesAs('TEXT FROM THE SCANNED PAGE');
        const out = await extract('mixed.pdf');
        if ('declined' in out) throw new Error(`unexpected decline: ${out.declined}`);
        expect(out.text).toContain('native page text');
        expect(out.text).toContain('TEXT FROM THE SCANNED PAGE');
        expect(out.pdfClass).toBe('C');
        expect(out.method).toBe('ocr');
        // The gap is closed: nothing is left unread.
        expect(out.unreadPages).toBeUndefined();
    });

    it('still reports a gap for pages OCR could not read', async () => {
        recognizesAs('');
        const out = await extract('mixed.pdf');
        if ('declined' in out) throw new Error(`unexpected decline: ${out.declined}`);
        expect(out.text).toContain('native page text');
        expect(out.unreadPages).toEqual([2]);
        expect(out.pdfClass).toBe('C');
    });

    it('leaves a fully native document untouched — OCR is never invoked', async () => {
        recognizesAs('should never be reached');
        const out = await extract('multi-page.pdf');
        if ('declined' in out) throw new Error(`unexpected decline: ${out.declined}`);
        expect(out.pdfClass).toBe('A');
        expect(recognizeImages).not.toHaveBeenCalled();
    });
});
