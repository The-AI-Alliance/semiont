/**
 * The text layer's offsets count code points.
 *
 * An item's `start` and `end`, and a page's `textStart` and `textEnd`, are
 * offsets into the layer's text: Unicode code points from its start. A string
 * counts a character outside the Basic Multilingual Plane as two, so every
 * offset after one differs from the string's own position, and a page after
 * one is shifted by a different amount in each count.
 *
 * pdf.js is stood in for here. The standard fonts the fixture generator draws
 * with encode no such character, and what is under test is the arithmetic
 * over the strings pdf.js hands back, which it hands back as JavaScript
 * strings whatever the document.
 */

import { describe, it, expect, vi } from 'vitest';
import { textOffsets } from '@semiont/core';

const run = (str: string, x: number, y: number, hasEOL = false) =>
    ({ str, transform: [1, 0, 0, 1, x, y], width: 40, height: 12, hasEOL });

const PAGES = [
    [run('𝒜lgebra', 72, 700, true), run('😀', 72, 686), run('done', 90, 686)],
    [run('second', 72, 700), run('page', 120, 700)],
];

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
    getDocument: () => ({
        promise: Promise.resolve({
            numPages: PAGES.length,
            getPage: async (pageNumber: number) => ({
                getViewport: () => ({ width: 612, height: 792 }),
                getTextContent: async () => ({ items: PAGES[pageNumber - 1] }),
            }),
            getFieldObjects: async () => null,
        }),
        destroy: async () => {},
    }),
}));

const { extractPdfTextLayer } = await import('../extract-pdf-text-layer');

describe('a text layer with characters outside the basic plane', () => {
    it('shifts a later page by the code points before it', async () => {
        const layer = await extractPdfTextLayer(new Uint8Array());
        if (!layer) throw new Error('expected a layer');

        expect(layer.text).toBe('𝒜lgebra\n😀 done \nsecond page \n');
        expect(layer.items.map((item) => [item.page, item.start, item.end])).toEqual([
            [1, 0, 7], [1, 8, 9], [1, 10, 14],
            [2, 16, 22], [2, 23, 27],
        ]);

        const offsets = textOffsets(layer.text);
        expect(layer.items.map((item) => layer.text.slice(offsets.indexAt(item.start), offsets.indexAt(item.end))))
            .toEqual(PAGES.flat().map((r) => r.str));
    });

    it('states each page\'s span of the text in code points', async () => {
        const layer = await extractPdfTextLayer(new Uint8Array());
        if (!layer) throw new Error('expected a layer');

        expect(layer.pages.map((page) => [page.textStart, page.textEnd])).toEqual([[0, 16], [16, 29]]);
        const offsets = textOffsets(layer.text);
        expect(offsets.length).toBe(29);
        expect(layer.pages.map((page) => layer.text.slice(offsets.indexAt(page.textStart), offsets.indexAt(page.textEnd))))
            .toEqual(['𝒜lgebra\n😀 done \n', 'second page \n']);
    });
});
