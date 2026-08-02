/**
 * prepareDetection (#736, rewritten for #739) — the media axis and the
 * `buildAnnotation` closures it returns.
 *
 * Detection now reads through the SAME extractor registry the Smelter embeds
 * from, so these tests drive the real registry wherever they can: a text
 * resource decodes for real, and only the PDF slot is stubbed (jobs carries no
 * PDF fixtures). The wiring being proven is that the anchoring model follows
 * the GEOMETRY, not the media type — positioned runs anchor by viewrect,
 * their absence anchors by character offset in that same text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resourceId } from '@semiont/core';
import type { components } from '@semiont/core';
import type { PdfTextItem } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';

vi.mock('@semiont/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/content')>();
  return {
    ...actual,
    EXTRACTORS: { ...actual.EXTRACTORS, 'pdf-text-layer': { extract: vi.fn() } },
  };
});
vi.mock('@semiont/event-sourcing', () => ({
  generateAnnotationId: vi.fn(() => 'ann-prep-test'),
}));

import { EXTRACTORS } from '@semiont/content';
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

function fakeSession(text = 'alpha beta gamma') {
  const bytes = new TextEncoder().encode(text);
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  const resourceRepresentation = vi.fn(async () => ({ data, contentType: 'text/markdown' }));
  const session = {
    client: { browse: { resourceRepresentation } },
  } as unknown as SemiontSession;
  return { session, resourceRepresentation };
}

type Sel = { type: string; start?: number; end?: number; value?: string };
const selectors = (ann: Record<string, unknown>): Sel[] =>
  (ann.target as { selector: Sel[] }).selector;

describe('prepareDetection', () => {
  beforeEach(() => pdfExtract.mockReset());

  it('text: decodes for real and anchors by character offsets in that SAME text', async () => {
    const { session, resourceRepresentation } = fakeSession();

    const source = await prepareDetection('text/markdown', session, RID, USER_DID, GENERATOR);
    if ('declined' in source) throw new Error(`unexpected decline: ${source.declined}`);

    expect(resourceRepresentation).toHaveBeenCalledOnce();
    expect(source.text).toBe('alpha beta gamma');

    const ann = source.buildAnnotation('highlighting', { exact: 'alpha', start: 0, end: 5 }) as Record<string, unknown>;
    expect(ann.motivation).toBe('highlighting');
    expect((ann.target as { source: string }).source).toBe(RID);
    const sels = selectors(ann);
    expect(sels.find((s) => s.type === 'TextPositionSelector')).toMatchObject({ start: 0, end: 5 });
    expect(sels.some((s) => s.type === 'TextQuoteSelector')).toBe(true);
    // The closure closed over the decoded text: a span that does not match it
    // trips buildTextAnnotation's content invariant.
    expect(() => source.buildAnnotation('highlighting', { exact: 'zzz', start: 0, end: 3 })).toThrow(/invariant/);
  });

  it('positioned runs: anchors by viewrect geometry from the SAME extraction', async () => {
    const { session } = fakeSession();
    pdfExtract.mockResolvedValue({ text: PDF_TEXT, items: PDF_ITEMS, method: 'pdf-text-layer', pdfClass: 'A' });

    const source = await prepareDetection('application/pdf', session, RID, USER_DID, GENERATOR);
    if ('declined' in source) throw new Error(`unexpected decline: ${source.declined}`);
    expect(source.text).toBe(PDF_TEXT);

    const ann = source.buildAnnotation('highlighting', { exact: 'alpha', start: 0, end: 5 }) as Record<string, unknown>;
    const sels = selectors(ann);
    expect(sels.find((s) => s.type === 'FragmentSelector')?.value).toMatch(/^page=1&viewrect=/);
    expect(sels.some((s) => s.type === 'TextPositionSelector')).toBe(false);
    expect(sels.some((s) => s.type === 'TextQuoteSelector')).toBe(true);
  });

  it('a scanned PDF that OCR read is anchored spatially, like any other geometry', async () => {
    // The point of #739: OCR'd words are ordinary positioned runs, so class B
    // takes the identical path a native text layer does.
    const { session } = fakeSession();
    pdfExtract.mockResolvedValue({ text: PDF_TEXT, items: PDF_ITEMS, method: 'ocr', pdfClass: 'B' });

    const source = await prepareDetection('application/pdf', session, RID, USER_DID, GENERATOR);
    if ('declined' in source) throw new Error('unexpected decline');
    const ann = source.buildAnnotation('highlighting', { exact: 'gamma', start: 11, end: 16 }) as Record<string, unknown>;
    expect(selectors(ann).find((s) => s.type === 'FragmentSelector')?.value).toMatch(/^page=1&viewrect=/);
  });

  it("passes an extractor's own decline through by name", async () => {
    const { session } = fakeSession();
    pdfExtract.mockResolvedValue({ declined: 'encrypted' });

    expect(await prepareDetection('application/pdf', session, RID, USER_DID, GENERATOR))
      .toEqual({ declined: 'encrypted' });
  });

  it("declines 'no-extractor' for a media type that can never yield text", async () => {
    const { session, resourceRepresentation } = fakeSession();

    expect(await prepareDetection('application/zip', session, RID, USER_DID, GENERATOR))
      .toEqual({ declined: 'no-extractor' });
    // Nothing is fetched — the media type alone settles it.
    expect(resourceRepresentation).not.toHaveBeenCalled();
  });

  it("declines 'empty' when extraction yields nothing to detect over", async () => {
    const { session } = fakeSession('   \n  ');

    expect(await prepareDetection('text/markdown', session, RID, USER_DID, GENERATOR))
      .toEqual({ declined: 'empty' });
  });
});
