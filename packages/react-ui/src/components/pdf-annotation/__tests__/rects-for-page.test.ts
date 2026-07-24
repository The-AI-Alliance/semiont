/**
 * rectsForPage axioms (#735) — the pure partition that distributes an annotation's
 * FragmentSelectors into per-page rects. Geometry (each coord → canvas pixels) is
 * covered separately by the pdf-coordinates transform axioms + the core codec axioms.
 *
 * The only producer of multi-selector PDF annotations is AI detection (#736), which
 * doesn't exist yet — so these synthetic fixtures stand in for it.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { annotationId, resourceId, type Annotation } from '@semiont/core';
import { rectsForPage } from '../rects-for-page';

const PAGES = 5;

type Sel = { page: number; x: number; y: number; w: number; h: number };

const selArb: fc.Arbitrary<Sel> = fc.record({
  page: fc.integer({ min: 1, max: PAGES }),
  x: fc.integer({ min: 0, max: 800 }),
  y: fc.integer({ min: 0, max: 800 }),
  w: fc.integer({ min: 1, max: 200 }),
  h: fc.integer({ min: 1, max: 60 }),
});
// A "document" is a list of annotations, each a list of 0..4 selectors.
const docArb = fc.array(fc.array(selArb, { maxLength: 4 }), { maxLength: 6 });

function build(doc: ReadonlyArray<ReadonlyArray<Sel>>): Annotation[] {
  return doc.map((sels, i): Annotation => ({
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(`ann-${i}`),
    target: {
      source: resourceId('res-1'),
      selector: sels.map(s => ({
        type: 'FragmentSelector' as const,
        value: `page=${s.page}&viewrect=${s.x},${s.y},${s.w},${s.h}`,
        conformsTo: 'http://tools.ietf.org/rfc/rfc3778',
      })),
    },
    motivation: 'highlighting',
    created: '2026-01-01T00:00:00.000Z',
  }));
}

const keysOn = (anns: Annotation[], page: number): string[] =>
  rectsForPage(anns, page).map(r => `${r.annId}:${r.selectorIndex}`);

describe('rectsForPage (#735 multi-rect partition)', () => {
  it('completeness: every FragmentSelector renders exactly once across all pages', () => {
    fc.assert(fc.property(docArb, doc => {
      const anns = build(doc);
      const total = doc.reduce((n, sels) => n + sels.length, 0);
      let rendered = 0;
      for (let p = 1; p <= PAGES; p++) rendered += rectsForPage(anns, p).length;
      expect(rendered).toBe(total);
    }));
  });

  it('page-locality: every rect on page p came from a selector with page === p', () => {
    fc.assert(fc.property(docArb, fc.integer({ min: 1, max: PAGES }), (doc, p) => {
      for (const r of rectsForPage(build(doc), p)) expect(r.coord.page).toBe(p);
    }));
  });

  it('key uniqueness: `${annId}:${selectorIndex}` is pairwise unique on any page', () => {
    fc.assert(fc.property(docArb, fc.integer({ min: 1, max: PAGES }), (doc, p) => {
      const keys = keysOn(build(doc), p);
      expect(new Set(keys).size).toBe(keys.length);
    }));
  });

  it('order independence: reversing the annotation list preserves the rendered set per page', () => {
    fc.assert(fc.property(docArb, fc.integer({ min: 1, max: PAGES }), (doc, p) => {
      const anns = build(doc);
      expect([...keysOn([...anns].reverse(), p)].sort()).toEqual([...keysOn(anns, p)].sort());
    }));
  });

  it('single-selector invariance: a manual (one-selector) annotation → exactly one rect on its page', () => {
    const anns = build([[{ page: 2, x: 72, y: 720, w: 150, h: 12 }]]);
    const onPage2 = rectsForPage(anns, 2);
    expect(onPage2).toHaveLength(1);
    expect(onPage2[0].selectorIndex).toBe(0);
    expect(rectsForPage(anns, 1)).toHaveLength(0);
  });

  it('multi-line: a 3-selector annotation on one page → 3 distinctly-keyed rects', () => {
    const anns = build([[
      { page: 2, x: 72, y: 720, w: 150, h: 12 },
      { page: 2, x: 72, y: 700, w: 140, h: 12 },
      { page: 2, x: 72, y: 680, w: 90, h: 12 },
    ]]);
    expect(keysOn(anns, 2)).toEqual(['ann-0:0', 'ann-0:1', 'ann-0:2']);
  });
});
