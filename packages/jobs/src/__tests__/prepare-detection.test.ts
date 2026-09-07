/**
 * prepareDetection (#736, rewritten for #739) — the media axis and the
 * `buildAnnotation` closures it returns.
 *
 * Detection now reads through the SAME extractor registry the Smelter embeds
 * from, so these tests drive the real registry wherever they can: a text
 * resource decodes for real, and only the PDF slot is stubbed — this suite
 * is the dispatch layer. The cache seam inside the REAL pdf extractor is
 * covered by the sibling `prepare-detection.cache.test.ts` (PERSIST-ANCHORS
 * P2d), which is why every call here passes an always-miss store. The
 * wiring being proven is that the anchoring model follows the GEOMETRY, not
 * the media type — positioned runs anchor by viewrect, their absence
 * anchors by character offset in that same text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resourceId } from '@semiont/core';
import type { components } from '@semiont/core';
import type { PdfTextItem } from '@semiont/core';

vi.mock('@semiont/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/content')>();
  return {
    ...actual,
    EXTRACTORS: { ...actual.EXTRACTORS, 'pdf-text-layer': { extract: vi.fn(), yieldsGeometry: true } },
  };
});
// No `@semiont/event-sourcing` mock: annotation ids are content-addressed
// (JOB-RESTART-SAFETY P3), so the real function is already deterministic. The
// mock existed only to buy that determinism, and keeping it would hide the
// identity these builders now compute — which is the thing worth exercising.

import { EXTRACTORS, type ContentReads } from '@semiont/content';
import { prepareDetection } from '../workers/detection/prepare-detection';

type Agent = components['schemas']['Agent'];

const RID = resourceId('res-prep');
const USER_DID = 'did:web:test.local:users:alice%40test.local';
const GENERATOR: Agent = {
  '@type': 'Software',
  '@id': 'did:web:test.local:agents:test:test',
  name: 'test',
  provider: 'test',
  model: 'test',
};

const PDF_TEXT = 'alpha beta\ngamma delta';
const PDF_ITEMS: PdfTextItem[] = [
  { start: 0,  end: 5,  page: 1, x: 72,  y: 720, width: 40, height: 12 },
  { start: 6,  end: 10, page: 1, x: 118, y: 720, width: 34, height: 12 },
  { start: 11, end: 16, page: 1, x: 72,  y: 700, width: 45, height: 12 },
  { start: 17, end: 22, page: 1, x: 125, y: 700, width: 42, height: 12 },
];

/** The PDF slot, stubbed — the only extractor these tests fake. */
const pdfExtract = vi.mocked(EXTRACTORS['pdf-text-layer']!.extract);

/**
 * The byte read, serving `text`. A plain `ContentReads` rather than a
 * hollowed-out session: since SINGLE-KB-MOUNT P4 the seam takes the read it
 * actually wants, so the double needs no cast to claim it is something
 * larger.
 */
function fakeReads(text = 'alpha beta gamma') {
  const bytes = new TextEncoder().encode(text);
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  const getBinary = vi.fn(async () => ({ data, contentType: 'text/markdown' }));
  const reads: ContentReads = { getBinary };
  return { reads, getBinary };
}

/** The geometry consult (SMELTER-OWNS-OCR P2) — a spy over
 * `browse.resourceAnchoredText`. Default: a settled map. */
function fakeConsult(answer: unknown = { kind: 'extracted', text: PDF_TEXT, items: PDF_ITEMS, method: 'pdf-text-layer' }) {
  const consult = vi.fn(async () => answer as never);
  return { consult };
}

type Sel = { type: string; start?: number; end?: number; value?: string };
const selectors = (ann: Record<string, unknown>): Sel[] =>
  (ann.target as { selector: Sel[] }).selector;

describe('prepareDetection', () => {
  beforeEach(() => { pdfExtract.mockReset(); });

  // ── NON-geometry: decode the bytes, no consult ──────────────────────────

  it('text: decodes for real and anchors by character offsets in that SAME text', async () => {
    const { reads, getBinary } = fakeReads();
    const { consult } = fakeConsult();

    const source = await prepareDetection('text/markdown', reads, RID, USER_DID, GENERATOR, consult);
    if ('declined' in source) throw new Error(`unexpected decline: ${source.declined}`);

    expect(getBinary).toHaveBeenCalledOnce();
    // The Smelter publishes nothing for non-geometry types, so consulting would
    // always miss and then block on an artifact that is never coming.
    expect(consult).not.toHaveBeenCalled();
    expect(source.text).toBe('alpha beta gamma');

    const ann = source.buildAnnotation('highlighting', { exact: 'alpha', start: 0, end: 5 }) as Record<string, unknown>;
    const sels = selectors(ann);
    expect(sels.find((s) => s.type === 'TextPositionSelector')).toMatchObject({ start: 0, end: 5 });
    expect(sels.some((s) => s.type === 'TextQuoteSelector')).toBe(true);
    expect(() => source.buildAnnotation('highlighting', { exact: 'zzz', start: 0, end: 3 })).toThrow(/invariant/);
  });

  it("declines 'empty' when a decoded non-geometry resource yields nothing to detect over", async () => {
    const { reads } = fakeReads('   \n  ');
    const { consult } = fakeConsult();
    expect(await prepareDetection('text/markdown', reads, RID, USER_DID, GENERATOR, consult))
      .toEqual({ declined: 'empty' });
  });

  // ── GEOMETRY-bearing: consult the Smelter, never fetch or OCR ────────────

  it('PDF: text comes from the CONSULT with its geometry, and getBinary is NOT called', async () => {
    // The headline of SMELTER-OWNS-OCR P2: a geometry type reads canonical text
    // from the Smelter. Assert on the CALL, not the result — a fetch whose bytes
    // are discarded still downloads 39 MB, and an OCR pass still burns the CPU.
    const { reads, getBinary } = fakeReads();
    const { consult } = fakeConsult({ kind: 'extracted', text: PDF_TEXT, items: PDF_ITEMS, method: 'pdf-text-layer' });

    const source = await prepareDetection('application/pdf', reads, RID, USER_DID, GENERATOR, consult);
    if ('declined' in source) throw new Error(`unexpected decline: ${source.declined}`);

    expect(consult).toHaveBeenCalledWith(RID);
    expect(getBinary).not.toHaveBeenCalled();
    expect(pdfExtract).not.toHaveBeenCalled();
    expect(source.text).toBe(PDF_TEXT);

    const ann = source.buildAnnotation('highlighting', { exact: 'alpha', start: 0, end: 5 }) as Record<string, unknown>;
    const sels = selectors(ann);
    expect(sels.find((s) => s.type === 'FragmentSelector')?.value).toMatch(/^page=1&viewrect=/);
    expect(sels.some((s) => s.type === 'TextPositionSelector')).toBe(false);
    expect(sels.some((s) => s.type === 'TextQuoteSelector')).toBe(true);
  });

  it('a class A PDF takes the consult path too — the rule is yieldsGeometry, not "is it a scan"', async () => {
    // A class-A carve-out would reintroduce a second producer for an operation
    // that is merely *probably* deterministic. The consult, not the pdfClass,
    // decides.
    const { reads, getBinary } = fakeReads();
    const { consult } = fakeConsult({ kind: 'extracted', text: PDF_TEXT, items: PDF_ITEMS, method: 'pdf-text-layer' });

    const source = await prepareDetection('application/pdf', reads, RID, USER_DID, GENERATOR, consult);
    if ('declined' in source) throw new Error('unexpected decline');
    expect(consult).toHaveBeenCalledOnce();
    expect(getBinary).not.toHaveBeenCalled();
  });

  it("a not-yet consult answer declines 'not-yet' — no fetch, no OCR (the RETRY case)", async () => {
    const { reads, getBinary } = fakeReads();
    const { consult } = fakeConsult({ kind: 'not-yet' });

    expect(await prepareDetection('application/pdf', reads, RID, USER_DID, GENERATOR, consult))
      .toEqual({ declined: 'not-yet' });
    // No fallback extraction: a local OCR pass that runs and is discarded still
    // burns the CPU this plan exists to stop duplicating.
    expect(getBinary).not.toHaveBeenCalled();
    expect(pdfExtract).not.toHaveBeenCalled();
  });

  it("a no-map consult answer declines 'no-map' (TERMINAL — drift on a geometry type)", async () => {
    const { reads } = fakeReads();
    const { consult } = fakeConsult({ kind: 'no-map' });
    expect(await prepareDetection('application/pdf', reads, RID, USER_DID, GENERATOR, consult))
      .toEqual({ declined: 'no-map' });
  });

  it("an unknown consult answer declines 'unknown' (TERMINAL — no content identity)", async () => {
    const { reads } = fakeReads();
    const { consult } = fakeConsult({ kind: 'unknown' });
    expect(await prepareDetection('application/pdf', reads, RID, USER_DID, GENERATOR, consult))
      .toEqual({ declined: 'unknown' });
  });

  it("a genuine content decline passes through the consult by name", async () => {
    const { reads } = fakeReads();
    const { consult } = fakeConsult({ kind: 'declined', declined: 'encrypted' });
    expect(await prepareDetection('application/pdf', reads, RID, USER_DID, GENERATOR, consult))
      .toEqual({ declined: 'encrypted' });
  });

  it("declines 'empty' when the consulted map has blank text", async () => {
    const { reads } = fakeReads();
    const { consult } = fakeConsult({ kind: 'extracted', text: '   ', items: [], method: 'pdf-text-layer' });
    expect(await prepareDetection('application/pdf', reads, RID, USER_DID, GENERATOR, consult))
      .toEqual({ declined: 'empty' });
  });

  // ── media-type gate, unchanged ──────────────────────────────────────────

  it("declines 'no-extractor' for a media type that can never yield text", async () => {
    const { reads, getBinary } = fakeReads();
    const { consult } = fakeConsult();

    expect(await prepareDetection('application/zip', reads, RID, USER_DID, GENERATOR, consult))
      .toEqual({ declined: 'no-extractor' });
    expect(getBinary).not.toHaveBeenCalled();
    expect(consult).not.toHaveBeenCalled();
  });
});
