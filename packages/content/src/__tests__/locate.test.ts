import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { describe, it, expect } from 'vitest';
import { locate } from '../locate';
import { extractPdfTextLayer } from '../extract-pdf-text-layer';
import { createFragmentSelector, parseFragmentSelector, getPageFromFragment } from '@semiont/core';

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
    // #734 gate — the coordinate round-trip spike. A known fixture word's
    // PDF-point geometry, run through the canonical Y-flip, must land on the
    // expected canvas pixels. The flip MUST mirror react-ui's
    // pdfToCanvasCoordinates (canvasY = pageHeight - y - height); content must
    // not depend on react-ui, so that function is guarded independently by
    // axiom 4 in packages/react-ui/src/lib/__tests__/pdf-coordinates.test.ts.
    // The two tests together pin the coordinate convention.
    it('round-trip spike: fixture geometry survives the PDF→canvas Y-flip', async () => {
        const layer = await extractPdfTextLayer(readFixture('single-line.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        const start = layer.text.indexOf(KNOWN_PHRASE);
        const { rects } = locate(layer, start, start + KNOWN_PHRASE.length);
        if (rects.length === 0) throw new Error('expected rects, got empty array');

        const rect = rects[0];
        const pageDimensions = layer.pages[rect.page - 1];

        const canvasX = rect.x;
        const canvasY = pageDimensions.heightPt - rect.y - rect.height;

        expect(canvasX).toBeCloseTo(EXPECTED_CANVAS_X);
        expect(canvasY).toBeCloseTo(EXPECTED_CANVAS_Y);
    });

    // The content→core handoff that #736's buildPdfAnnotation depends on:
    // locate() emits PDF-point geometry, the core viewrect codec serializes it to
    // an RFC 3778 page=N&viewrect=... value and reads it back unchanged.
    it('round-trips locate() geometry through the core viewrect codec', async () => {
        const layer = await extractPdfTextLayer(readFixture('single-line.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        const start = layer.text.indexOf(KNOWN_PHRASE);
        const { rects } = locate(layer, start, start + KNOWN_PHRASE.length);
        expect(rects).toHaveLength(1);

        const fragment = createFragmentSelector(rects[0]);
        expect(getPageFromFragment(fragment)).toBe(rects[0].page);
        expect(parseFragmentSelector(fragment)).toEqual(rects[0]);
    });

    it('returns one PdfCoordinate for a single-line span', async () => {
        const layer = await extractPdfTextLayer(readFixture('single-line.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        const start = layer.text.indexOf(KNOWN_PHRASE);
        expect(start).toBeGreaterThanOrEqual(0);

        const { rects } = locate(layer, start, start + KNOWN_PHRASE.length);
        expect(rects).toHaveLength(1);
        expect(rects[0].page).toBe(1);
        expect(rects[0].width).toBeGreaterThan(0);
        expect(rects[0].x).toBeCloseTo(EXPECTED_RECTS_X, 1)
        expect(rects[0].y).toBeCloseTo(EXPECTED_RECTS_Y, 1)
    });
    
    it('returns one rect per line for a multi-line span', async () => {
        const layer = await extractPdfTextLayer(readFixture('multi-line.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        const { rects } = locate(layer, 0, layer.text.length - 1);
        expect(rects.length).toBeGreaterThan(1);

        const ys = rects.map(r => r.y);  // Extracts y value from every rect into an array
        // Assert all y values are unique, i.e. each rect is on a different line
        expect (new Set(ys).size).toBe(ys.length);  
    });
    
    it('returns empty array when span has no matching items', async () => {
        const layer = await extractPdfTextLayer(readFixture('single-line.pdf'));
        if (!layer) throw new Error('expected layer, got null');
        const { rects } = locate(layer, 99999, 100000);
        expect(rects).toHaveLength(0);
    });
    
    it('documents known imperfect reading order for multi-column PDFs', async () => {
        // Multi-column reading order is a known limitation (Phase 4 / #738): pdf.js
        // yields one column fully before the other, so true row-wise reading order
        // across columns is not preserved. Assert the (imperfect) current order
        // explicitly rather than snapshotting an opaque blob.
        const layer = await extractPdfTextLayer(readFixture('multi-column.pdf'));
        if (!layer) throw new Error('expected layer, got null');

        const order = [
            'left column line one',
            'left column line two',
            'right column line one',
            'right column line two',
        ];
        const positions = order.map(s => layer.text.indexOf(s));
        positions.forEach(p => expect(p).toBeGreaterThanOrEqual(0));
        // Column-major: the entire left column precedes the entire right column.
        for (let i = 1; i < positions.length; i++) {
            expect(positions[i]).toBeGreaterThan(positions[i - 1]);
        }
        // ...and adjacent lines no longer glue across the seam (the #6 fix).
        expect(layer.text).not.toContain('oneleft');
        expect(layer.text).not.toContain('tworight');
    });
});