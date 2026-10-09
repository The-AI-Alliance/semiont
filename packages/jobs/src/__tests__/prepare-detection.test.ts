/**
 * prepareDetection — the media axis and the
 * `buildAnnotation` closures it returns.
 *
 * Detection reads a resource by the SAME media-type text source the Smelter
 * embeds from, so these tests drive the real route wherever they can: a text
 * resource decodes for real, and only the PDF route is stubbed — this suite
 * is the dispatch layer. That route is the Smelter consult: a geometry-bearing
 * type's text and geometry come from the Smelter's anchored text, so this
 * worker holds no store and extracts nothing itself. The wiring being proven
 * is that the anchoring model follows the GEOMETRY, not the media type —
 * positioned runs anchor by viewrect, their absence anchors by character
 * offset in that same text.
 */
import { describe, it, expect, vi } from 'vitest';
import { resourceId } from '@semiont/core';
import type { components } from '@semiont/core';
import type { PdfTextItem } from '@semiont/core';

// No `@semiont/content` mock. This seam imports nothing from it that runs —
// deriving is reachable only through `derivingExtractorFor` and callable only
// with an `AnchoredTextStore`, which this worker does not have.
// The `readRepresentation` assertions below prove "the worker did not OCR"
// observably: no bytes fetched is no derivation possible.
// No `@semiont/event-sourcing` mock: annotation ids are content-addressed, so
// the real function is deterministic, and a mock would hide the identity
// these builders compute — which is the thing worth exercising.

import { prepareDetection, type ReadRepresentation } from '../workers/detection/prepare-detection';

type Agent = components['schemas']['Agent'];

const RID = resourceId('res-prep');
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

/**
 * The byte read, serving `text`: the one function the seam takes, which in
 * the worker is the client's own `browse.resourceRepresentation`. A plain
 * function rather than a hollowed-out session, so the double needs no cast to
 * claim it is something larger.
 */
function fakeReads(text = 'alpha beta gamma') {
  const bytes = new TextEncoder().encode(text);
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  const readRepresentation = vi.fn<ReadRepresentation>(async () => ({ data, contentType: 'text/markdown' }));
  return { reads: readRepresentation, readRepresentation };
}

/** The geometry consult, where a geometry-bearing type's detection text comes
 * from — a spy over `browse.resourceAnchoredText`. Default: a settled map. */
function fakeConsult(answer: unknown = { kind: 'extracted', text: PDF_TEXT, items: PDF_ITEMS, method: 'pdf-text-layer' }) {
  const consult = vi.fn(async () => answer as never);
  return { consult };
}

type Sel = { type: string; start?: number; end?: number; value?: string };
const selectors = (ann: Record<string, unknown>): Sel[] =>
  (ann.target as { selector: Sel[] }).selector;

describe('prepareDetection', () => {

  // ── NON-geometry: decode the bytes, no consult ──────────────────────────

  it('text: decodes for real and anchors by character offsets in that SAME text', async () => {
    const { reads, readRepresentation } = fakeReads();
    const { consult } = fakeConsult();

    const source = await prepareDetection('text/markdown', reads, RID, GENERATOR, consult);
    if ('declined' in source) throw new Error(`unexpected decline: ${source.declined}`);

    expect(readRepresentation).toHaveBeenCalledExactlyOnceWith(RID);
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

  it('text: a span after a character outside the Basic Multilingual Plane is anchored at a count of code points', async () => {
    // The emoji is one code point and two units of a string: `Ada Lovelace`
    // is from 2 to 14, and a string's own positions would say 3 to 15.
    const { reads } = fakeReads('😀 Ada Lovelace wrote the first algorithm.');
    const { consult } = fakeConsult();

    const source = await prepareDetection('text/markdown', reads, RID, GENERATOR, consult);
    if ('declined' in source) throw new Error(`unexpected decline: ${source.declined}`);

    const ann = source.buildAnnotation('highlighting', { exact: 'Ada Lovelace', start: 2, end: 14 }) as Record<string, unknown>;
    expect(selectors(ann).find((s) => s.type === 'TextPositionSelector')).toEqual({ type: 'TextPositionSelector', start: 2, end: 14 });
    expect(() => source.buildAnnotation('highlighting', { exact: 'Ada Lovelace', start: 3, end: 15 })).toThrow(/invariant/);
  });

  it("declines 'empty' when a decoded non-geometry resource yields nothing to detect over", async () => {
    const { reads } = fakeReads('   \n  ');
    const { consult } = fakeConsult();
    expect(await prepareDetection('text/markdown', reads, RID, GENERATOR, consult))
      .toEqual({ declined: 'empty' });
  });

  // ── GEOMETRY-bearing: consult the Smelter, never fetch or OCR ────────────

  it('PDF: text comes from the CONSULT with its geometry, and no bytes are read', async () => {
    // The headline: the Smelter owns OCR, so a geometry type reads canonical
    // text from the Smelter. Assert on the CALL, not the result — a fetch whose
    // bytes are discarded still downloads 39 MB, and an OCR pass still burns
    // the CPU.
    const { reads, readRepresentation } = fakeReads();
    const { consult } = fakeConsult({ kind: 'extracted', text: PDF_TEXT, items: PDF_ITEMS, method: 'pdf-text-layer' });

    const source = await prepareDetection('application/pdf', reads, RID, GENERATOR, consult);
    if ('declined' in source) throw new Error(`unexpected decline: ${source.declined}`);

    expect(consult).toHaveBeenCalledWith(RID);
    expect(readRepresentation).not.toHaveBeenCalled();
    expect(source.text).toBe(PDF_TEXT);

    const ann = source.buildAnnotation('highlighting', { exact: 'alpha', start: 0, end: 5 }) as Record<string, unknown>;
    const sels = selectors(ann);
    expect(sels.find((s) => s.type === 'FragmentSelector')?.value).toMatch(/^page=1&viewrect=/);
    expect(sels.some((s) => s.type === 'TextPositionSelector')).toBe(false);
    expect(sels.some((s) => s.type === 'TextQuoteSelector')).toBe(true);
  });

  it('PDF: items and a span after a character outside the Basic Multilingual Plane count code points', async () => {
    // `beta` is the item from 8 to 12: the emoji before it is one code point.
    const text = '😀 alpha beta\ngamma delta';
    const items: PdfTextItem[] = [
      { start: 0,  end: 1,  page: 1, x: 60,  y: 720, width: 10, height: 12 },
      { start: 2,  end: 7,  page: 1, x: 72,  y: 720, width: 40, height: 12 },
      { start: 8,  end: 12, page: 1, x: 118, y: 720, width: 34, height: 12 },
      { start: 13, end: 18, page: 1, x: 72,  y: 700, width: 45, height: 12 },
      { start: 19, end: 24, page: 1, x: 125, y: 700, width: 42, height: 12 },
    ];
    const { reads } = fakeReads();
    const { consult } = fakeConsult({ kind: 'extracted', text, items, method: 'pdf-text-layer' });

    const source = await prepareDetection('application/pdf', reads, RID, GENERATOR, consult);
    if ('declined' in source) throw new Error(`unexpected decline: ${source.declined}`);

    const ann = source.buildAnnotation('highlighting', { exact: 'beta', start: 8, end: 12 }) as Record<string, unknown>;
    expect(selectors(ann).filter((s) => s.type === 'FragmentSelector').map((s) => s.value)).toEqual(['page=1&viewrect=118,720,34,12']);
  });

  it('a class A PDF takes the consult path too — the rule is yieldsGeometryOf, not "is it a scan"', async () => {
    // A class-A carve-out would introduce a second producer for an operation
    // that is merely *probably* deterministic. The consult, not the pdfClass,
    // decides.
    const { reads, readRepresentation } = fakeReads();
    const { consult } = fakeConsult({ kind: 'extracted', text: PDF_TEXT, items: PDF_ITEMS, method: 'pdf-text-layer' });

    const source = await prepareDetection('application/pdf', reads, RID, GENERATOR, consult);
    if ('declined' in source) throw new Error('unexpected decline');
    expect(consult).toHaveBeenCalledOnce();
    expect(readRepresentation).not.toHaveBeenCalled();
  });

  it("a not-yet consult answer declines 'not-yet' — no fetch, no OCR (the RETRY case)", async () => {
    const { reads, readRepresentation } = fakeReads();
    const { consult } = fakeConsult({ kind: 'not-yet' });

    expect(await prepareDetection('application/pdf', reads, RID, GENERATOR, consult))
      .toEqual({ declined: 'not-yet' });
    // No fallback extraction: a local OCR pass that runs and is discarded still
    // burns the CPU the consult exists to stop duplicating.
    expect(readRepresentation).not.toHaveBeenCalled();
  });

  it("a no-map consult answer declines 'no-map' (TERMINAL — drift on a geometry type)", async () => {
    const { reads } = fakeReads();
    const { consult } = fakeConsult({ kind: 'no-map' });
    expect(await prepareDetection('application/pdf', reads, RID, GENERATOR, consult))
      .toEqual({ declined: 'no-map' });
  });

  it("an unknown consult answer declines 'unknown' (TERMINAL — no content identity)", async () => {
    const { reads } = fakeReads();
    const { consult } = fakeConsult({ kind: 'unknown' });
    expect(await prepareDetection('application/pdf', reads, RID, GENERATOR, consult))
      .toEqual({ declined: 'unknown' });
  });

  it("a genuine content decline passes through the consult by name", async () => {
    const { reads } = fakeReads();
    const { consult } = fakeConsult({ kind: 'declined', declined: 'encrypted' });
    expect(await prepareDetection('application/pdf', reads, RID, GENERATOR, consult))
      .toEqual({ declined: 'encrypted' });
  });

  it("declines 'empty' when the consulted map has blank text", async () => {
    const { reads } = fakeReads();
    const { consult } = fakeConsult({ kind: 'extracted', text: '   ', items: [], method: 'pdf-text-layer' });
    expect(await prepareDetection('application/pdf', reads, RID, GENERATOR, consult))
      .toEqual({ declined: 'empty' });
  });

  // ── media-type gate ─────────────────────────────────────────────────────

  it("declines 'no-extractor' for a media type that can never yield text", async () => {
    const { reads, readRepresentation } = fakeReads();
    const { consult } = fakeConsult();

    expect(await prepareDetection('application/zip', reads, RID, GENERATOR, consult))
      .toEqual({ declined: 'no-extractor' });
    expect(readRepresentation).not.toHaveBeenCalled();
    expect(consult).not.toHaveBeenCalled();
  });
});
