/**
 * Tables and offsets: a cell is read out of the text by its runs' offsets,
 * and a rendered cell is given offsets into the text it is rendered into.
 *
 * Both count code points. A string counts a character outside the Basic
 * Multilingual Plane as two, so a cell after one is read from the wrong
 * place, or anchored to it, wherever the string's own positions are used.
 */

import { describe, it, expect } from 'vitest';
import { textOffsets, type PdfTextItem } from '@semiont/core';
import { detectTable, renderTable, type TableCell } from '../pdf-tables';

describe('detectTable', () => {
    it('reads each cell at its runs\' offsets, after characters outside the basic plane', () => {
        const text = '😀 Arm Dose\n𝔸x 5mg\nB 7mg\n';
        const at = (start: number, end: number, x: number, y: number): PdfTextItem =>
            ({ start, end, page: 1, x, y, width: 30, height: 12 });
        const items = [
            at(2, 5, 72, 700), at(6, 10, 200, 700),
            at(11, 13, 72, 680), at(14, 17, 200, 680),
            at(18, 19, 72, 660), at(20, 23, 200, 660),
        ];

        const rows = detectTable(items, text, textOffsets(text));

        expect(rows?.map((row) => row.map((cell) => cell.text)))
            .toEqual([['Arm', 'Dose'], ['𝔸x', '5mg'], ['B', '7mg']]);
    });
});

describe('renderTable', () => {
    it('anchors each cell in code points, from where the table lands', () => {
        const cell = (text: string, x: number, y: number): TableCell => ({ text, x, y, width: 30, height: 12 });
        const rows = [
            [cell('𝔸rm', 72, 700), cell('Dose', 200, 700)],
            [cell('😀', 72, 680), cell('5 mg', 200, 680)],
            [cell('B', 72, 660), cell('7 mg', 200, 660)],
        ];

        const rendered = renderTable(rows, 3, 10);

        expect(rendered.text).toBe('| 𝔸rm | Dose |\n| --- | --- |\n| 😀 | 5 mg |\n| B | 7 mg |\n');
        expect(rendered.items.map((item) => [item.start, item.end])).toEqual([
            [12, 15], [18, 22],
            [41, 42], [45, 49],
            [54, 55], [58, 62],
        ]);
        expect(rendered.items.every((item) => item.page === 3)).toBe(true);

        const offsets = textOffsets(rendered.text);
        expect(rendered.items.map((item) => rendered.text.slice(offsets.indexAt(item.start - 10), offsets.indexAt(item.end - 10))))
            .toEqual(rows.flat().map((c) => c.text));
    });
});
