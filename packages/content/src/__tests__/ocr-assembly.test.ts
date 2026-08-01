/**
 * OCR page assembly — text and word offsets, built together (#739).
 *
 * The offsets are the risky part: `buildPdfAnnotation` slices the assembled
 * text between a match's overlapping items and THROWS unless that substring
 * contains the match, so an off-by-one here surfaces as a failed annotation
 * rather than a slightly wrong box. That cannot be tested through a synthetic
 * raster — no legible glyphs — so the assembler is tested directly against a
 * hand-built recognition tree.
 */

import { describe, it, expect } from 'vitest';
import { assemblePage, type OcrBlock } from '../ocr';

const word = (text: string, x0: number) => ({
    text,
    confidence: 90,
    bbox: { x0, y0: 10, x1: x0 + text.length * 8, y1: 26 },
});

const tree = (lines: string[][][]): OcrBlock[] => [
    {
        paragraphs: lines.map((paragraph) => ({
            lines: paragraph.map((words) => ({
                words: words.map((w, i) => word(w, 20 + i * 60)),
            })),
        })),
    },
];

describe('assemblePage', () => {
    it('joins words with spaces and lines with newlines', () => {
        const { text } = assemblePage(tree([[['the', 'quick'], ['brown', 'fox']]]));
        expect(text).toBe('the quick\nbrown fox');
    });

    it('separates paragraphs with a blank line', () => {
        const { text } = assemblePage(tree([[['first']], [['second']]]));
        expect(text).toBe('first\n\nsecond');
    });

    it('gives every word an offset that selects exactly that word', () => {
        const { text, words } = assemblePage(tree([[['the', 'quick'], ['brown', 'fox']]]));
        expect(words.map((w) => w.text)).toEqual(['the', 'quick', 'brown', 'fox']);
        // The invariant that matters: slicing by the recorded range returns the
        // word itself, for every word.
        for (const w of words) {
            expect(text.slice(w.start, w.end)).toBe(w.text);
        }
    });

    it('carries each word geometry and confidence through unchanged', () => {
        const { words } = assemblePage(tree([[['alpha']]]));
        expect(words[0]).toMatchObject({
            text: 'alpha',
            confidence: 90,
            bbox: { x0: 20, y0: 10, x1: 60, y1: 26 },
        });
    });

    it('skips empty words without disturbing the offsets', () => {
        const blocks: OcrBlock[] = [
            { paragraphs: [{ lines: [{ words: [word('real', 20), word('   ', 90), word('words', 150)] }] }] },
        ];
        const { text, words } = assemblePage(blocks);
        expect(text).toBe('real words');
        expect(words).toHaveLength(2);
        for (const w of words) expect(text.slice(w.start, w.end)).toBe(w.text);
    });

    it('is empty for a page the engine could not read', () => {
        expect(assemblePage(null)).toEqual({ text: '', words: [] });
        expect(assemblePage([])).toEqual({ text: '', words: [] });
    });
});
