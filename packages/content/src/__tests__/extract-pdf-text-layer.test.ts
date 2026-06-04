import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { describe, it, expect } from 'vitest';
import { extractPdfTextLayer } from '../extract-pdf-text-layer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name: string): Uint8Array => 
    new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));

const KNOWN_PHRASE = 'known phrase from fixture';

describe('extractPdfTextLayer', () => {
    it('items carry correct character ranges / offsets into text', async () => {
        const layer = await extractPdfTextLayer(readFixture('single-line.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        for (const item of layer.items) {
            expect(item.end).toBeGreaterThan(item.start);
            expect(item.start).toBeGreaterThanOrEqual(0);
            expect(item.end).toBeLessThanOrEqual(layer.text.length);
        }
    });

    it('returns a layer with correct text for single-line PDF', async () => {
        const layer = await extractPdfTextLayer(readFixture('single-line.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        expect(layer.text).toContain(KNOWN_PHRASE);
        expect(layer.items.length).toBeGreaterThan(0);
        expect(layer.pages).toHaveLength(1);
    });

    it('returns a layer with correct text for a multi-line PDF', async () => {
        const layer = await extractPdfTextLayer(readFixture('multi-line.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        expect(layer.text).toContain('first line of text');
        expect(layer.text).toContain('second line of text');
        expect(layer.text).toContain('third line of text');
        expect(layer.pages).toHaveLength(1);
        expect(layer.items.length).toBeGreaterThan(0);

        // Line seams must carry a separator — words must not glue across lines
        // (regression guard for the hasEOL-aware separator).
        expect(layer.text).not.toContain('textsecond');
        expect(layer.text).not.toContain('textthird');
    });

    it('captures correct page dimension metadata for single-page PDF', async () => {
        const layer = await extractPdfTextLayer(readFixture('multi-line.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        expect(layer.pages[0].pageNumber).toBe(1);
        expect(layer.pages[0].widthPt).toBeGreaterThan(0);
        expect(layer.pages[0].heightPt).toBeGreaterThan(0);
    });

    it('captures correct page count and dimension metadata for multi-page PDF', async () =>{
        const layer = await extractPdfTextLayer(readFixture('multi-page.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        expect(layer.pages).toHaveLength(2);
        expect(layer.pages[0].pageNumber).toBe(1);
        expect(layer.pages[1].pageNumber).toBe(2);
    });

    it('contains text from both pages of a multi-page PDF', async () => {
        const layer = await extractPdfTextLayer(readFixture('multi-page.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        expect(layer.text).toContain('content on page one');
        expect(layer.text).toContain('content on page two');
    });

    it('assigns correct page numbers to items across pages for a multi-page PDF', async () => {
        const layer = await extractPdfTextLayer(readFixture('multi-page.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        const pageOneItems = layer.items.filter(i => i.page === 1);
        const pageTwoItems = layer.items.filter(i => i.page === 2);
        expect(pageOneItems.length).toBeGreaterThan(0);
        expect(pageTwoItems.length).toBeGreaterThan(0);
    });

    it('returns null for a scanned PDF with no text layer', async () => {
        const layer = await extractPdfTextLayer(readFixture('scanned.pdf'));
        expect(layer).toBeNull();
    });
});



