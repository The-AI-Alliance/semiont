import { describe, it, expect } from 'vitest';
import { findClaimSpan } from '../pdf-citation-search';
import { locate, type AnchoredText } from '../pdf-anchoring';

/**
 * The two-stage citation search over a generated PDF's text layer.
 *
 * A citation's `exact` claim text comes from the Typst SOURCE; the PDF's text
 * layer renders it with line breaks (`anchorRuns` joins runs with " \n") and
 * hyphenation (soft hyphens are DROPPED — "extraordinarily" becomes
 * "extraor" + "dinarily" with no hyphen character anywhere). Two stages, in
 * order, never collapsed:
 *
 *   1. STRICT — whitespace-normalized search, offsets mapped back. Bridges
 *      plain line breaks (" \n" collapses to " ").
 *   2. BREAK-AWARE — only on a strict miss. The line break becomes a distinct
 *      marker that may be absorbed in any inter-character gap; ordinary
 *      spaces are NEVER wildcards.
 *
 * The ordering is the safety property: the permissive matcher runs only where
 * the strict one already failed, so it can never turn a working citation into
 * a wrong one.
 */
describe('findClaimSpan', () => {
  const anchoredWith = (text: string): AnchoredText => ({ text, items: [] });

  it('finds a claim within a single line (strict)', () => {
    const anchored = anchoredWith('The quick brown fox jumps over the lazy dog.');

    const span = findClaimSpan(anchored, 'brown fox jumps');

    expect(span).not.toBeNull();
    expect(anchored.text.slice(span!.start, span!.end)).toBe('brown fox jumps');
  });

  it('finds a claim across a line break via normalization (strict)', () => {
    // anchorRuns joins runs with " \n": a raw indexOf misses.
    const anchored = anchoredWith('The quick brown \nfox jumps high.');

    const span = findClaimSpan(anchored, 'brown fox');

    expect(span).not.toBeNull();
    expect(anchored.text.slice(span!.start, span!.end)).toBe('brown \nfox');
  });

  it('finds a hyphenated claim via the break-aware fallback', () => {
    // Soft hyphen dropped: "extraor" + "dinarily", no hyphen char anywhere.
    // Plain normalization yields "extraor dinarily" — a strict miss.
    const anchored = anchoredWith('It is extraor \ndinarily complicated today.');

    const span = findClaimSpan(anchored, 'extraordinarily complicated');

    expect(span).not.toBeNull();
    expect(anchored.text.slice(span!.start, span!.end)).toBe('extraor \ndinarily complicated');
  });

  it('never treats ordinary spaces as wildcards — "abc" must not match "a b c"', () => {
    expect(findClaimSpan(anchoredWith('x a b c y'), 'abc')).toBeNull();
  });

  it('returns null on a genuine miss', () => {
    expect(findClaimSpan(anchoredWith('Entirely unrelated text.'), 'quantum entanglement')).toBeNull();
  });

  // A string compares code units, and would find half of a pair inside a
  // character outside the Basic Multilingual Plane. The text does not have
  // such a claim there, character for character, and the place has no offset.
  it('does not find a claim that begins with half of a pair inside a character (strict)', () => {
    expect('a😀bc'.indexOf('\ude00bc')).toBe(2);
    expect(findClaimSpan(anchoredWith('a😀bc'), '\ude00bc')).toBeNull();
  });

  it('nor one that only the break-aware search could find there', () => {
    expect(findClaimSpan(anchoredWith('a😀b\nc'), '\ude00bc')).toBeNull();
  });
});

describe('locate — proportional boundary narrowing', () => {
  // Typst emits one text run per line, so without clipping a mid-line phrase
  // would bound the WHOLE line. Boundary items' x-extents are interpolated
  // proportionally by character fraction — a rect narrower than the line;
  // exact glyph metrics need the operator-list route.
  it('a mid-line phrase produces a rect narrower than the line', () => {
    const anchored: AnchoredText = {
      text: '0123456789',
      items: [{ start: 0, end: 10, page: 1, x: 100, y: 700, width: 100, height: 10 }],
    };

    const { rects } = locate(anchored, 2, 6); // chars '2345'

    expect(rects).toHaveLength(1);
    const r = rects[0]!;
    expect(r.x).toBeCloseTo(120, 5); // 100 + 100 * (2/10)
    expect(r.width).toBeCloseTo(40, 5); // 100 * (4/10)
    expect(r.y).toBe(700);
  });
});
