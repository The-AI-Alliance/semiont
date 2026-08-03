/**
 * locate — given a span of text, which rectangles cover it.
 *
 * The direction a model-produced annotation takes: it quotes text, and the
 * viewer has to draw a box. `textUnder` is the inverse and lives beside it.
 *
 * Real extracted PDFs exercise this too, in `@semiont/content`, where a fixture
 * can actually be produced — but that is an integration test of the extractor
 * feeding the arithmetic, and it lives in another package. The rules below are
 * pure arithmetic over plain data, so they are pinned here in isolation, for
 * the same reason `text-under.test.ts` gives: a real fixture adds extraction
 * noise without exercising anything extra.
 *
 * Coordinates are PDF points, bottom-left origin (Y increases upward).
 */
import { describe, it, expect } from 'vitest';
import { locate, isTextRun, type AnchoredText } from '../pdf-anchoring';

//   y=700  Hello world again        (page 1)
//   y=680  Second line              (page 1)
//   y=700  Elsewhere                (page 2)
const LAYER: AnchoredText = {
  text: 'Hello world again\nSecond line\nElsewhere',
  items: [
    { start: 0, end: 5, page: 1, x: 72, y: 700, width: 30, height: 12 },   // Hello
    { start: 6, end: 11, page: 1, x: 106, y: 700, width: 32, height: 12 }, // world
    { start: 12, end: 17, page: 1, x: 142, y: 700, width: 30, height: 12 },// again
    { start: 18, end: 24, page: 1, x: 72, y: 680, width: 38, height: 12 }, // Second
    { start: 25, end: 29, page: 1, x: 114, y: 680, width: 22, height: 12 },// line
    { start: 30, end: 39, page: 2, x: 72, y: 700, width: 50, height: 12 }, // Elsewhere
  ],
};

describe('locate', () => {
  it('boxes a single run', () => {
    const { rects } = locate(LAYER, 6, 11);

    expect(rects).toEqual([{ page: 1, x: 106, y: 700, width: 32, height: 12 }]);
  });

  it('merges runs sharing a line into ONE rectangle spanning them', () => {
    // Not one box per word: a reader sees a single highlight over the phrase.
    // Right edge comes from the last run's x+width (142+30), not its x.
    const { rects } = locate(LAYER, 0, 17);

    expect(rects).toEqual([{ page: 1, x: 72, y: 700, width: 100, height: 12 }]);
  });

  it('emits one rectangle per line for a span that wraps', () => {
    const { rects } = locate(LAYER, 0, 29);

    expect(rects).toEqual([
      { page: 1, x: 72, y: 700, width: 100, height: 12 },
      { page: 1, x: 72, y: 680, width: 64, height: 12 },
    ]);
  });

  it('keeps rectangles on their own pages for a span that crosses one', () => {
    // A page break must not produce a rectangle spanning both, which is what
    // grouping by line alone would do — the two lines share y=700.
    const { rects } = locate(LAYER, 0, 39);

    expect(rects).toHaveLength(3);
    expect(rects.map((r) => r.page)).toEqual([1, 1, 2]);
    expect(rects[2]).toEqual({ page: 2, x: 72, y: 700, width: 50, height: 12 });
  });

  it('orders lines top-to-bottom, which in PDF space is DESCENDING y', () => {
    const { rects } = locate(LAYER, 0, 29);

    expect(rects.map((r) => r.y)).toEqual([700, 680]);
  });

  it('returns the overlapping items alongside the rectangles', () => {
    // The single-scan contract: a caller needing the covered text reuses this
    // rather than filtering `items` a second time.
    const { overlap } = locate(LAYER, 0, 17);

    expect(overlap.map((i) => LAYER.text.slice(i.start, i.end)))
      .toEqual(['Hello', 'world', 'again']);
  });

  it('answers empty for a span no run covers', () => {
    // Both arrays, so a caller destructuring either is safe.
    expect(locate(LAYER, 500, 600)).toEqual({ rects: [], overlap: [] });
  });

  it('treats the span as half-open: [start, end)', () => {
    // Exactly the run: covered. Its end offset alone: not — `end` is exclusive,
    // so a zero-width or seam-only span selects nothing rather than the run
    // that merely abuts it.
    expect(locate(LAYER, 0, 5).overlap).toHaveLength(1);
    expect(locate(LAYER, 5, 6).overlap).toHaveLength(0);
    expect(locate(LAYER, 5, 5).overlap).toHaveLength(0);
  });

  describe('line grouping tolerates a baseline that is not perfectly flat', () => {
    // Runs on one typeset line rarely share an exact y. Within the threshold
    // they are one line; past it they are two — which is what stops a slightly
    // drifting baseline from collapsing into a single tall box, and what makes
    // page skew show up as extra rects rather than a wrong one.
    const drifted = (y: number): AnchoredText => ({
      text: 'ab',
      items: [
        { start: 0, end: 1, page: 1, x: 72, y: 700, width: 10, height: 12 },
        { start: 1, end: 2, page: 1, x: 90, y, width: 10, height: 12 },
      ],
    });

    it('groups runs within 2pt of each other', () => {
      const { rects } = locate(drifted(698.5), 0, 2);

      expect(rects).toHaveLength(1);
      expect(rects[0]).toMatchObject({ x: 72, width: 28 });
    });

    it('splits runs further apart than that', () => {
      const { rects } = locate(drifted(696), 0, 2);

      expect(rects).toHaveLength(2);
    });

    it('takes the bounding box over a grouped line, not the first run\'s', () => {
      // y is the minimum and height reaches the tallest top, so a grouped line
      // encloses every run in it rather than clipping the lower one.
      const { rects } = locate(drifted(698.5), 0, 2);

      expect(rects[0]).toMatchObject({ y: 698.5, height: 13.5 });
    });
  });
});

describe('isTextRun', () => {
  // The boundary rule both producers filter with: pdf.js interleaves
  // marked-content items with text runs, and only the latter carry `str`.
  it('accepts an item carrying str', () => {
    expect(isTextRun({ str: 'a', transform: [1, 0, 0, 1, 0, 0], width: 1, height: 1 })).toBe(true);
  });

  it('rejects a marked-content item, and anything that is not an object', () => {
    expect(isTextRun({ type: 'beginMarkedContent' })).toBe(false);
    expect(isTextRun(null)).toBe(false);
    expect(isTextRun(undefined)).toBe(false);
    expect(isTextRun('str')).toBe(false);
  });
});
