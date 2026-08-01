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
import { recognizeImages, type OcrWord } from '../ocr';

vi.mock('../ocr', () => ({ recognizeImages: vi.fn() }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));

const extract = (fixture: string) =>
    EXTRACTORS['pdf-text-layer']!.extract(readFixture(fixture), 'application/pdf');

/** Every image recognizes as the same known text, as one word per token. */
const recognizesAs = (text: string) => {
    vi.mocked(recognizeImages).mockImplementation(async (images = []) =>
        images.map(() => {
            const words: OcrWord[] = [];
            let cursor = 0;
            for (const token of text.split(' ').filter(Boolean)) {
                words.push({
                    text: token,
                    start: cursor,
                    end: cursor + token.length,
                    bbox: { x0: cursor * 10, y0: 0, x1: cursor * 10 + token.length * 8, y1: 16 },
                    confidence: 90,
                });
                cursor += token.length + 1;
            }
            return { text, words };
        }),
    );
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

    it('anchors every recovered word to a range that selects it', async () => {
        // The offset invariant, end to end: `buildPdfAnnotation` slices the
        // text by these ranges and throws if the result does not contain the
        // match, so drift here surfaces as a failed annotation, not a nudged box.
        recognizesAs('RECOVERED FROM THE SCAN');
        const out = await extract('scanned-image.pdf');
        if ('declined' in out) throw new Error(`unexpected decline: ${out.declined}`);
        expect(out.items?.length).toBe(4);
        for (const block of out.items!) {
            expect(out.text.slice(block.start, block.end)).toMatch(/^(RECOVERED|FROM|THE|SCAN)$/);
        }
    });

    it('places words on the page in PDF points, not pixels', async () => {
        recognizesAs('SCANNED');
        const out = await extract('scanned-image.pdf');
        if ('declined' in out) throw new Error('unexpected decline');
        const [block] = out.items!;
        // The fixture's raster covers the whole 612×792 page, so any word must
        // land inside it — pixel coordinates (max 240×140) would not.
        expect(block!.page).toBe(1);
        expect(block!.x).toBeGreaterThanOrEqual(0);
        expect(block!.x + block!.width).toBeLessThanOrEqual(612);
        expect(block!.y).toBeGreaterThanOrEqual(0);
        expect(block!.y + block!.height).toBeLessThanOrEqual(792);
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

        // Native and OCR'd geometry coexist, and each still selects its own
        // text — the native items were not disturbed by appending.
        const native = out.items!.filter((b) => b.page === 1);
        const scanned = out.items!.filter((b) => b.page === 2);
        expect(native.length).toBeGreaterThan(0);
        expect(scanned.length).toBe(5);
        for (const block of scanned) {
            expect(out.text.slice(block.start, block.end)).toMatch(/^(TEXT|FROM|THE|SCANNED|PAGE)$/);
        }
        // One run, because the fixture draws the phrase in a single call —
        // native items are text runs, not words.
        expect(out.text.slice(native[0]!.start, native[0]!.end)).toBe('native page text');
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
