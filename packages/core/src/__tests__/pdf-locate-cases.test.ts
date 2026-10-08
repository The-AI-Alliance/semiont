/**
 * Locating a span of a PDF's text, held to
 * specs/src/annotations/pdf-locate-cases.json: the table every worker runs, so
 * that a span is anchored to the same rectangles, written as the same
 * selectors, and a claim found at the same place, whoever does it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { locate, type AnchoredText, type PdfTextItem } from '../pdf-anchoring';
import { createFragmentSelector, type PdfCoordinate } from '../pdf-coordinates';
import { findClaimSpan } from '../pdf-citation-search';

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

interface ClaimCase {
  why: string;
  text: string;
  claim: string;
  /** `null` when the claim is not found. */
  span: Span | null;
}

const table: { cases: LocateCase[]; claims: ClaimCase[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/annotations/pdf-locate-cases.json', import.meta.url), 'utf8'),
);

describe('locating a span of a PDF (specs/src/annotations/pdf-locate-cases.json)', () => {
  it('has cases of each kind', () => {
    expect(table.cases.length).toBeGreaterThan(0);
    expect(table.claims.length).toBeGreaterThan(0);
  });

  for (const { why, anchored, span, overlapping, rects, fragments } of table.cases) {
    it(why, () => {
      const located = locate(anchored, span.start, span.end);
      expect(located.overlap, 'overlapping').toStrictEqual(overlapping);
      expect(located.rects, 'rects').toStrictEqual(rects);
      expect(rects.map(createFragmentSelector), 'fragments').toStrictEqual(fragments);
    });
  }

  for (const { why, text, claim, span } of table.claims) {
    it(why, () => {
      expect(findClaimSpan({ text, items: [] }, claim)).toStrictEqual(span);
    });
  }
});
