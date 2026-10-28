/**
 * Locating a span of a PDF's text, held to the `cases` of
 * specs/src/annotations/pdf-locate-cases.json: the table every implementation
 * runs, so that a span is anchored to the same rectangles and written as the
 * same selectors, whoever does it. The table's `claims` are the rule of
 * Semiont's worker alone, and are run there.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { locate, type AnchoredText, type PdfTextItem } from '../pdf-anchoring';
import { createFragmentSelector, type PdfCoordinate } from '../pdf-coordinates';

interface Span {
  start: number;
  end: number;
}

interface LocateCase {
  why: string;
  anchored: AnchoredText;
  span: Span;
  overlapping: PdfTextItem[];
  rects: PdfCoordinate[];
  /** The FragmentSelector value of each of `rects`, in their order. */
  fragments: string[];
}

const table: { cases: LocateCase[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/annotations/pdf-locate-cases.json', import.meta.url), 'utf8'),
);

describe('locating a span of a PDF (specs/src/annotations/pdf-locate-cases.json)', () => {
  it('has cases', () => {
    expect(table.cases.length).toBeGreaterThan(0);
  });

  for (const { why, anchored, span, overlapping, rects, fragments } of table.cases) {
    it(why, () => {
      const located = locate(anchored, span.start, span.end);
      expect(located.overlap, 'overlapping').toStrictEqual(overlapping);
      expect(located.rects, 'rects').toStrictEqual(rects);
      expect(rects.map(createFragmentSelector), 'fragments').toStrictEqual(fragments);
    });
  }
});
