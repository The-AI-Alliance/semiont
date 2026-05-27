import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { describe, it, expect } from 'vitest';
import { locate } from '../locate';
import { extractPdfTextLayer } from '../extract-pdf-text-layer';

const EXPECTED_CANVAS_X = 72;
const EXPECTED_CANVAS_Y = 60;
const EXPECTED_RECTS_X = 72;
const EXPECTED_RECTS_Y = 720;
const KNOWN_PHRASE = 'known phrase from fixture';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name: string): Uint8Array =>
  new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));

describe('locate', () => {
    it('converts PDF coordinates to canvas coordinates correctly', async () => {
        const layer = await extractPdfTextLayer(readFixture('single-line.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        const start = layer.text.indexOf(KNOWN_PHRASE);
        const rects = locate(layer, start, start + KNOWN_PHRASE.length);
        if (rects.length === 0) throw new Error('expected rects, got empty array');

        const rect = rects[0]
        const pageDimensions = layer.pages[rect.page - 1];

        // Apply Y-flip formula to convert PDF coords to canvas coords
        const canvasX = rect.x;
        const canvasY = pageDimensions.heightPt - rect.y - rect.height;

        expect(canvasX).toBeCloseTo(EXPECTED_CANVAS_X);
        expect(canvasY).toBeCloseTo(EXPECTED_CANVAS_Y);
    });

    it('returns one PdfCoordinate for a single-line span', async () => {
        const layer = await extractPdfTextLayer(readFixture('single-line.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        const start = layer.text.indexOf(KNOWN_PHRASE);
        expect(start).toBeGreaterThanOrEqual(0);

        const rects = locate(layer, start, start + KNOWN_PHRASE.length);
        expect(rects).toHaveLength(1);
        expect(rects[0].page).toBe(1);
        expect(rects[0].width).toBeGreaterThan(0);
        expect(rects[0].x).toBeCloseTo(EXPECTED_RECTS_X, 1)
        expect(rects[0].y).toBeCloseTo(EXPECTED_RECTS_Y, 1)
    });
    
    it('returns one rect per line for a multi-line span', async () => {
        const layer = await extractPdfTextLayer(readFixture('multi-line.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        const rects = locate(layer, 0, layer.text.length - 1);
        expect(rects.length).toBeGreaterThan(1);

        const ys = rects.map(r => r.y);  // Extracts y value from every rect into an array
        // Assert all y values are unique, i.e. each rect is on a different line
        expect (new Set(ys).size).toBe(ys.length);  
    });
    
    it('returns empty array when span has no matching items', async () => {
        const layer = await extractPdfTextLayer(readFixture('single-line.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        const rects = locate(layer, 99999, 100000);
        expect(rects).toHaveLength(0);
    });
    
    it('documents known imperfect reading order for multi-column PDFs', async () => {
        // Pins current behavior — does NOT assert correct column ordering.
        // Multi-column reading order is a known limitation, deferred to Phase 4 (#738).
        const layer = await extractPdfTextLayer(readFixture('multi-column.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        expect(layer.text).toMatchSnapshot();
    });
});