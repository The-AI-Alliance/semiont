/**
 * anchorRuns — the pdf.js run → AnchoredText kernel.
 *
 * This is the offset and separator convention that decides what `text` says
 * and where every item points into it. Both producers must use it: the server
 * extractor (@semiont/content, whole document) and the browser canvas
 * (react-ui, one page at drag time). If they diverged, `textUnder` would return
 * a different quote for the same rectangle depending on which side captured it.
 *
 * Input is structural, not pdf.js's `TextItem`: core takes no dependency on
 * pdfjs-dist. Each producer filters marked-content items at its own boundary
 * and passes the text runs through.
 */
import { describe, it, expect } from 'vitest';
import { anchorRuns, textUnder, type PdfTextRun } from '../pdf-anchoring';
import { textOffsets } from '../text-offsets';

// pdf.js text matrix: [a, b, c, d, x, y] — only x/y are read.
const run = (str: string, x: number, y: number, over: Partial<PdfTextRun> = {}): PdfTextRun => ({
  str,
  transform: [1, 0, 0, 1, x, y],
  width: str.length * 6,
  height: 12,
  ...over,
});

describe('anchorRuns', () => {
  it('records each run\'s own characters, separator excluded', () => {
    const { text, items } = anchorRuns([run('Hello', 72, 700), run('world', 106, 700)], 1);

    expect(text).toBe('Hello world ');
    expect(items).toHaveLength(2);
    expect(text.slice(items[0].start, items[0].end)).toBe('Hello');
    expect(text.slice(items[1].start, items[1].end)).toBe('world');
  });

  it('takes geometry from the text matrix and stamps the page', () => {
    const { items } = anchorRuns([run('Hello', 72, 700)], 4);

    expect(items[0]).toMatchObject({ page: 4, x: 72, y: 700, width: 30, height: 12 });
  });

  it('breaks the line on hasEOL rather than gluing words together', () => {
    const { text } = anchorRuns(
      [run('first', 72, 700, { hasEOL: true }), run('second', 72, 686)],
      1,
    );

    // Without the break this reads "firstsecond" — two lines fused into a word
    // that appears nowhere in the document.
    expect(text).toBe('first\nsecond ');
  });

  it('keeps a standalone end-of-line marker without emitting an item for it', () => {
    const { text, items } = anchorRuns(
      [run('first', 72, 700), run('   ', 0, 0, { hasEOL: true }), run('second', 72, 686)],
      1,
    );

    expect(text).toBe('first \nsecond ');
    expect(items).toHaveLength(2);
  });

  it('drops a whitespace-only run that carries no line break', () => {
    const { text, items } = anchorRuns([run('first', 72, 700), run('  ', 0, 0)], 1);

    expect(text).toBe('first ');
    expect(items).toHaveLength(1);
  });

  // An item's offsets count code points, as every offset into a text does. A
  // string counts a character outside the Basic Multilingual Plane as two, so
  // a run after one sits one further along the string than its offset says.
  it('counts each run\'s offsets in code points', () => {
    const runs = [
      run('𝔸lpha', 72, 700),
      run('😀', 110, 700, { hasEOL: true }),
      run('beta', 72, 686),
      run('gamma', 100, 686),
    ];
    const { text, items } = anchorRuns(runs, 1);

    expect(text).toBe('𝔸lpha 😀\nbeta gamma ');
    expect(items.map((item) => [item.start, item.end])).toEqual([[0, 5], [6, 7], [8, 12], [13, 18]]);
    const offsets = textOffsets(text);
    expect(items.map((item) => text.slice(offsets.indexAt(item.start), offsets.indexAt(item.end))))
      .toEqual(runs.map((r) => r.str));
  });

  it('produces empty AnchoredText for a page with no runs', () => {
    // A scanned page: pdf.js returns nothing, and the canvas must then emit
    // geometry with no quote rather than an empty one.
    expect(anchorRuns([], 1)).toEqual({ text: '', items: [] });
  });

  // The pairing that makes the whole path work: what anchorRuns produces,
  // textUnder can read back.
  it('produces AnchoredText that textUnder can quote from', () => {
    const anchored = anchorRuns(
      [run('Hello', 72, 700), run('world', 106, 700), run('elsewhere', 72, 600)],
      1,
    );

    expect(textUnder(anchored, { page: 1, x: 70, y: 698, width: 80, height: 16 }))
      .toBe('Hello world');
  });
});
