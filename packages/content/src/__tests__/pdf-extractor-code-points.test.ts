/**
 * Every offset the extractor makes or moves counts code points.
 *
 * A form's values, a table's cells, a page copied behind a table and the
 * words OCR recovers are each given offsets into a text assembled piece by
 * piece. A string counts a character outside the Basic Multilingual Plane as
 * two, so a piece after one lands at a different place in each count, and a
 * text sliced at an offset taken for a string position is cut one character
 * late for each such character before it.
 *
 * The reader, the page images and the engine are stood in for, so that each
 * shape of document is stated here as the text layer it reads as: no font the
 * fixture generator draws with encodes such a character.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOffsets, type PdfTextItem } from '@semiont/core';
import { derivingExtractorFor, type ExtractedText } from '../text-extractor';
import type { AnchoredTextStore } from '../anchored-text-store';
import type { PdfPageInfo, PdfTextLayer } from '../pdf-text-layer';
import { extractPdfTextLayer } from '../extract-pdf-text-layer';
import { extractPageImages, type PageImage } from '../pdf-page-images';
import { recognizeImages, type OcrWord } from '../ocr';

vi.mock('../extract-pdf-text-layer', () => ({ extractPdfTextLayer: vi.fn() }));
vi.mock('../pdf-page-images', () => ({ extractPageImages: vi.fn() }));
vi.mock('../ocr', () => ({ recognizeImages: vi.fn() }));

/** These cases are about what is derived, so the store keeps nothing. */
const KEEPS_NOTHING: AnchoredTextStore = { read: async () => null, write: async () => {}, list: async () => [] };

async function extract(layer: PdfTextLayer): Promise<ExtractedText> {
    vi.mocked(extractPdfTextLayer).mockResolvedValue(layer);
    const out = await derivingExtractorFor('application/pdf')!
        .extract(Buffer.from('%PDF-1.4'), 'application/pdf', { key: 'test', store: KEEPS_NOTHING });
    if (out.kind === 'declined') throw new Error(`unexpected decline: ${out.declined}`);
    return out;
}

const page = (pageNumber: number, textStart: number, textEnd: number, hasTextLayer = true): PdfPageInfo =>
    ({ pageNumber, widthPt: 612, heightPt: 792, textStart, textEnd, hasTextLayer });

const at = (start: number, end: number, pageNumber: number, x: number, y: number): PdfTextItem =>
    ({ start, end, page: pageNumber, x, y, width: 30, height: 12 });

const spans = (out: ExtractedText) => (out.items ?? []).map((item) => [item.start, item.end]);

/** The text each item's offsets select. */
function quoted(out: ExtractedText): string[] {
    const offsets = textOffsets(out.text);
    return (out.items ?? []).map((item) => out.text.slice(offsets.indexAt(item.start), offsets.indexAt(item.end)));
}

beforeEach(() => {
    vi.mocked(extractPdfTextLayer).mockReset();
    vi.mocked(extractPageImages).mockReset();
    vi.mocked(recognizeImages).mockReset();
});

describe('offsets after characters outside the basic plane', () => {
    it('a form: each value is anchored where it lands', async () => {
        const out = await extract({
            text: '😀 Form \n',
            items: [at(0, 6, 1, 72, 700)],
            pages: [page(1, 0, 8)],
            fields: [
                { name: 'n𝔸me', value: '𝒜da', page: 1, x: 100, y: 600, width: 80, height: 14 },
                { name: 'city', value: 'Paris', page: 1, x: 100, y: 580, width: 80, height: 14 },
            ],
        });

        expect(out).toMatchObject({ method: 'form', pdfClass: 'E' });
        expect(out.text).toBe('😀 Form \nn𝔸me: 𝒜da\ncity: Paris\n');
        expect(spans(out)).toEqual([[0, 6], [14, 17], [24, 29]]);
        expect(quoted(out)).toEqual(['😀 Form', '𝒜da', 'Paris']);
    });

    it('a table between two pages of prose: the cells, and the page copied behind them', async () => {
        const out = await extract({
            text: '😀 intro \nArm Dose\n𝔸x 5mg\nB 7mg \nafter \n',
            items: [
                at(0, 7, 1, 72, 700),
                at(9, 12, 2, 72, 700), at(13, 17, 2, 200, 700),
                at(18, 20, 2, 72, 680), at(21, 24, 2, 200, 680),
                at(25, 26, 2, 72, 660), at(27, 30, 2, 200, 660),
                at(32, 37, 3, 72, 700),
            ],
            pages: [page(1, 0, 9), page(2, 9, 32), page(3, 32, 39)],
            fields: [],
        });

        expect(out).toMatchObject({ method: 'table', pdfClass: 'D' });
        expect(out.text).toBe('😀 intro \n| Arm | Dose |\n| --- | --- |\n| 𝔸x | 5mg |\n| B | 7mg |\nafter \n');
        expect(spans(out)).toEqual([
            [0, 7],
            [11, 14], [17, 21],
            [40, 42], [45, 48],
            [53, 54], [57, 60],
            [63, 68],
        ]);
        expect(quoted(out)).toEqual(['😀 intro', 'Arm', 'Dose', '𝔸x', '5mg', 'B', '7mg', 'after']);
    });

    it('a hybrid: recovered words follow the native text, image after image and page after page', async () => {
        const image: PageImage = { png: Buffer.alloc(0), width: 100, height: 100, ctm: [612, 0, 0, 792, 0, 0] };
        const word = (text: string, start: number, end: number): OcrWord =>
            ({ text, start, end, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, confidence: 90 });
        // Page 2 is two images and page 3 is one.
        vi.mocked(extractPageImages).mockResolvedValue(new Map([[2, [image, image]], [3, [image]]]));
        vi.mocked(recognizeImages).mockResolvedValue([
            { text: '😀 scan', words: [word('😀', 0, 1), word('scan', 2, 6)] },
            { text: 'more', words: [word('more', 0, 4)] },
            { text: '𝒜 last', words: [word('𝒜', 0, 1), word('last', 2, 6)] },
        ]);

        const out = await extract({
            text: '𝔸 native \n\n\n',
            items: [at(0, 8, 1, 72, 700)],
            pages: [page(1, 0, 10), page(2, 10, 11, false), page(3, 11, 12, false)],
            fields: [],
        });

        expect(out).toMatchObject({ method: 'ocr', pdfClass: 'C' });
        expect(out.unreadPages).toBeUndefined();
        expect(out.text).toBe('𝔸 native \n\n\n😀 scan\nmore\n\n𝒜 last\n');
        expect((out.items ?? []).map((item) => item.page)).toEqual([1, 2, 2, 2, 3, 3]);
        expect(spans(out)).toEqual([[0, 8], [12, 13], [14, 18], [19, 23], [25, 26], [27, 31]]);
        expect(quoted(out)).toEqual(['𝔸 native', '😀', 'scan', 'more', '𝒜', 'last']);
    });
});
