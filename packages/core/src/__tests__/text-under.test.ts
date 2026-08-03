/**
 * textUnder — the inverse of locate(): given a rectangle, what text is under it.
 *
 * Drives the manual-annotation capture gap (.plans/PDF-MANUAL-ANNOTATION-TEXT.md):
 * a hand-drawn PDF rectangle currently stores geometry with no quoted text, so
 * every panel that quotes an annotation shows a blank entry.
 *
 * Fixtures are synthetic AnchoredText rather than real PDFs. The rules under
 * test are pure geometry-and-offset arithmetic; a real fixture would add
 * extraction noise without exercising anything extra, and hand-built items let
 * each rule be pinned in isolation.
 *
 * Coordinates are PDF points, bottom-left origin (Y increases upward) — the
 * same space PdfTextItem and PdfCoordinate use, so the canvas can pass its
 * drag rectangle straight in.
 *
 * locate(), the inverse direction, is pinned the same way in `locate.test.ts`
 * beside this file, and additionally exercised against real extracted PDFs in
 * @semiont/content, which is where a fixture can actually be produced.
 */
import { describe, it, expect } from 'vitest';
import { textUnder, type AnchoredText } from '../pdf-anchoring';

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

describe('textUnder', () => {
  it('returns the single run a rectangle covers', () => {
    expect(textUnder(LAYER, { page: 1, x: 104, y: 698, width: 36, height: 16 }))
      .toBe('world');
  });

  it('joins runs on one line using the document\'s own spacing', () => {
    expect(textUnder(LAYER, { page: 1, x: 70, y: 698, width: 70, height: 16 }))
      .toBe('Hello world');
  });

  it('keeps the real line break when a rectangle covers two lines', () => {
    expect(textUnder(LAYER, { page: 1, x: 70, y: 675, width: 110, height: 40 }))
      .toBe('Hello world again\nSecond line');
  });

  // The deliberate cost of RUN_COVERAGE_THRESHOLD. The box's left edge cuts
  // through "Second" (x 72..110), leaving 5pt of its 38pt width inside — 13%,
  // below the threshold — so it is dropped rather than quoted from a sliver.
  it('drops a run the rectangle only clips', () => {
    expect(textUnder(LAYER, { page: 1, x: 105, y: 675, width: 75, height: 40 }))
      .toBe('world again line');
  });

  it('ignores runs on other pages', () => {
    // A rectangle at Elsewhere's exact geometry, but on page 1.
    expect(textUnder(LAYER, { page: 1, x: 70, y: 695, width: 60, height: 20 }))
      .not.toContain('Elsewhere');
    expect(textUnder(LAYER, { page: 2, x: 70, y: 695, width: 60, height: 20 }))
      .toBe('Elsewhere');
  });

  it('returns empty string over blank space', () => {
    // Never an empty-string TextQuoteSelector: the caller drops the quote when
    // this is '' (PDF-MANUAL-ANNOTATION-TEXT, To settle 3).
    expect(textUnder(LAYER, { page: 1, x: 72, y: 400, width: 100, height: 20 }))
      .toBe('');
  });

  // pdf.js splits a word into several runs at kerning or font changes. Those
  // runs are adjacent in `text` with no separator, so a naive join(' ') would
  // emit "aga in" — a quote that appears nowhere in the document.
  it('does not insert a separator between runs that are adjacent in the text', () => {
    const split: AnchoredText = {
      text: 'again',
      items: [
        { start: 0, end: 3, page: 1, x: 72, y: 700, width: 18, height: 12 },
        { start: 3, end: 5, page: 1, x: 90, y: 700, width: 12, height: 12 },
      ],
    };
    expect(textUnder(split, { page: 1, x: 70, y: 698, width: 40, height: 16 }))
      .toBe('again');
  });

  // The over-inclusion trap. buildPdfAnnotation slices text from the first
  // covered offset to the last, which is safe there because the result only
  // feeds a containment check. Here the result IS the stored quote, so the
  // uncovered text between two covered runs must not be pulled in.
  it('does not pull in text between covered runs that the rectangle misses', () => {
    const twoLines: AnchoredText = {
      text: 'one two three\nfour five six',
      items: [
        { start: 0, end: 3, page: 1, x: 72, y: 700, width: 28, height: 12 },   // one
        { start: 4, end: 7, page: 1, x: 104, y: 700, width: 26, height: 12 },  // two
        { start: 8, end: 13, page: 1, x: 134, y: 700, width: 46, height: 12 }, // three
        { start: 14, end: 18, page: 1, x: 72, y: 680, width: 28, height: 12 }, // four
        { start: 19, end: 23, page: 1, x: 104, y: 680, width: 26, height: 12 },// five
        { start: 24, end: 27, page: 1, x: 134, y: 680, width: 26, height: 12 },// six
      ],
    };
    // A narrow rectangle down the left margin: the first word of each line.
    expect(textUnder(twoLines, { page: 1, x: 60, y: 675, width: 42, height: 40 }))
      .toBe('one four');
  });

  it('trims whitespace carried by the outermost runs', () => {
    const padded: AnchoredText = {
      text: '  Hello  ',
      items: [{ start: 0, end: 9, page: 1, x: 72, y: 700, width: 40, height: 12 }],
    };
    expect(textUnder(padded, { page: 1, x: 70, y: 698, width: 50, height: 16 }))
      .toBe('Hello');
  });

  // Pins RUN_COVERAGE_THRESHOLD, the rule that makes a hand-drawn box usable.
  // Lines here sit 20pt apart; on a real 12pt-set page the gap is ~2pt, so a
  // rectangle that grazes its neighbour is the normal case, not a corner case.
  it('ignores a line the rectangle merely grazes', () => {
    // Covers Second/line (y 680..692) fully, and reaches 1pt into the y=700
    // line — 8% of those runs, well under the threshold.
    expect(textUnder(LAYER, { page: 1, x: 70, y: 660, width: 200, height: 41 }))
      .toBe('Second line');
  });

  it('includes a line the rectangle covers most of', () => {
    // Reaches 8pt into the y=700 line: 67% of each 12pt-tall run.
    expect(textUnder(LAYER, { page: 1, x: 70, y: 660, width: 200, height: 48 }))
      .toBe('Hello world again\nSecond line');
  });
});
