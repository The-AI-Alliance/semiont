/**
 * buildPdfAnnotation (#736) — the geometry tail shared by every PDF detection
 * motivation. Pure over a synthetic PdfTextLayer: span + layer -> per-line
 * FragmentSelectors + a TextQuoteSelector, no TextPositionSelector, with the
 * geometry<->text containment invariant.
 */
import { describe, it, expect, vi } from 'vitest';
import { resourceId, type components } from '@semiont/core';
import type { PdfTextLayer } from '@semiont/content';

vi.mock('@semiont/event-sourcing', () => ({
  generateAnnotationId: vi.fn(() => 'ann-pdf-test'),
}));

import { buildPdfAnnotation } from '../processors';

type Agent = components['schemas']['Agent'];

const RID = resourceId('res-pdf');
const USER_DID = 'did:web:test.local:users:alice%40test.local';
const GENERATOR: Agent = {
  '@type': 'Software',
  '@id': 'did:web:test.local:agents:test:test',
  name: 'test',
  provider: 'test',
  model: 'test',
};

// Synthetic two-line layer — "alpha beta" (line 1, y=720) / "gamma delta" (line 2, y=700):
//   a0 l1 p2 h3 a4 _5 b6 e7 t8 a9 \n10 g11 a12 m13 m14 a15 _16 d17 e18 l19 t20 a21
const LAYER: PdfTextLayer = {
  pages: [{ pageNumber: 1, widthPt: 612, heightPt: 792 }],
  text: 'alpha beta\ngamma delta',
  items: [
    { start: 0,  end: 5,  page: 1, x: 72,  y: 720, width: 40, height: 12 }, // alpha
    { start: 6,  end: 10, page: 1, x: 118, y: 720, width: 34, height: 12 }, // beta
    { start: 11, end: 16, page: 1, x: 72,  y: 700, width: 45, height: 12 }, // gamma
    { start: 17, end: 22, page: 1, x: 125, y: 700, width: 42, height: 12 }, // delta
  ],
};

type PdfSel = { type: string; value?: string; conformsTo?: string; exact?: string; prefix?: string; suffix?: string };
const sels = (ann: ReturnType<typeof buildPdfAnnotation>): PdfSel[] => ann.target.selector as PdfSel[];
const frags = (ann: ReturnType<typeof buildPdfAnnotation>) => sels(ann).filter(s => s.type === 'FragmentSelector');

describe('buildPdfAnnotation (#736 geometry tail)', () => {
  it('single-line span -> one FragmentSelector + a TextQuoteSelector, and no TextPositionSelector', () => {
    const ann = buildPdfAnnotation(LAYER, RID, USER_DID, GENERATOR, 'highlighting',
      { exact: 'alpha beta', start: 0, end: 10 });
    const s = sels(ann);
    expect(frags(ann)).toHaveLength(1);
    expect(frags(ann)[0].value).toMatch(/^page=1&viewrect=/);
    expect(s.some(x => x.type === 'TextQuoteSelector')).toBe(true);
    expect(s.some(x => x.type === 'TextPositionSelector')).toBe(false);
    expect(ann.motivation).toBe('highlighting');
    expect(frags(ann)[0].conformsTo).toBe('http://tools.ietf.org/rfc/rfc3778');
  });

  it('multi-line span -> one FragmentSelector per line (2), each a distinct viewrect', () => {
    const ann = buildPdfAnnotation(LAYER, RID, USER_DID, GENERATOR, 'highlighting',
      { exact: 'beta\ngamma', start: 6, end: 16 });
    const f = frags(ann);
    expect(f).toHaveLength(2);
    expect(new Set(f.map(x => x.value)).size).toBe(2);
  });

  it('TextQuoteSelector carries exact + optional prefix/suffix', () => {
    const ann = buildPdfAnnotation(LAYER, RID, USER_DID, GENERATOR, 'highlighting',
      { exact: 'beta', start: 6, end: 10, prefix: 'alpha ', suffix: '\ngamma' });
    const tq = sels(ann).find(s => s.type === 'TextQuoteSelector');
    expect(tq?.exact).toBe('beta');
    expect(tq?.prefix).toBe('alpha ');
    expect(tq?.suffix).toBe('\ngamma');
  });

  it('invariant: throws when the covered text does not contain exact', () => {
    expect(() => buildPdfAnnotation(LAYER, RID, USER_DID, GENERATOR, 'highlighting',
      { exact: 'zzz not present', start: 0, end: 5 })).toThrow(/covered text does not contain exact/);
  });

  it('invariant: whitespace-normalized containment tolerates layer spacing (space vs newline)', () => {
    // `exact` uses a single space where the layer text has a line break.
    const ann = buildPdfAnnotation(LAYER, RID, USER_DID, GENERATOR, 'highlighting',
      { exact: 'beta gamma', start: 6, end: 16 });
    expect(frags(ann).length).toBeGreaterThanOrEqual(1);
  });

  it('attaches a body when provided (e.g. commenting)', () => {
    const body = { type: 'TextualBody', value: 'a note', format: 'text/plain' };
    const ann = buildPdfAnnotation(LAYER, RID, USER_DID, GENERATOR, 'commenting',
      { exact: 'alpha', start: 0, end: 5 }, body);
    expect((ann as Record<string, unknown>).body).toEqual(body);
  });

  it('linking motivation carries its detection-time body through the shared geometry', () => {
    // #737: at detection time a linking reference's body is the entity type as a
    // TextualBody (the SpecificResource target is appended later, at bind). The
    // geometry tail is identical to highlighting; only motivation + body differ.
    const body = { type: 'TextualBody', value: 'Person', purpose: 'tagging', format: 'text/plain' };
    const ann = buildPdfAnnotation(LAYER, RID, USER_DID, GENERATOR, 'linking',
      { exact: 'gamma delta', start: 11, end: 22 }, body);
    expect(ann.motivation).toBe('linking');
    expect((ann as Record<string, unknown>).body).toEqual(body);
    expect(frags(ann).length).toBeGreaterThanOrEqual(1);
    expect(sels(ann).some(x => x.type === 'TextQuoteSelector')).toBe(true);
    expect(sels(ann).some(x => x.type === 'TextPositionSelector')).toBe(false);
  });

  it('carries an array body (as commenting/tagging pass) unchanged', () => {
    // comment and tag hand buildAnnotation an ARRAY of bodies; the geometry tail
    // must pass either shape (single object | array) through verbatim.
    const body = [
      { type: 'TextualBody', value: 'Rule',   purpose: 'tagging',    format: 'text/plain' },
      { type: 'TextualBody', value: 'a note', purpose: 'commenting', format: 'text/plain' },
    ];
    const ann = buildPdfAnnotation(LAYER, RID, USER_DID, GENERATOR, 'tagging',
      { exact: 'alpha', start: 0, end: 5 }, body);
    expect((ann as Record<string, unknown>).body).toEqual(body);
    expect(Array.isArray((ann as Record<string, unknown>).body)).toBe(true);
  });
});
