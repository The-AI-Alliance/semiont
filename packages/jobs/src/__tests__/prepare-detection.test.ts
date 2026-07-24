/**
 * prepareDetection (#736) — direct coverage of the media-type axis, including
 * the returned `buildAnnotation` closures. The orchestration tests
 * (worker-process.test) mock all processors, so those closures never execute
 * there; this suite calls them and asserts real annotation output, proving the
 * delegation wiring: 'decode' → buildTextAnnotation over the SAME decoded text,
 * 'pdf-text-layer' → buildPdfAnnotation over the SAME extracted layer.
 */
import { describe, it, expect, vi } from 'vitest';
import { resourceId } from '@semiont/core';
import type { components } from '@semiont/core';
import type { PdfTextLayer } from '@semiont/content';
import type { SemiontSession } from '@semiont/sdk';

vi.mock('@semiont/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@semiont/content')>()),
  extractPdfTextLayer: vi.fn(),
}));
vi.mock('@semiont/event-sourcing', () => ({
  generateAnnotationId: vi.fn(() => 'ann-prep-test'),
}));

import { extractPdfTextLayer } from '@semiont/content';
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

// Synthetic two-line layer — same shape build-pdf-annotation.test pins.
const LAYER: PdfTextLayer = {
  pages: [{ pageNumber: 1, widthPt: 612, heightPt: 792 }],
  text: 'alpha beta\ngamma delta',
  items: [
    { start: 0,  end: 5,  page: 1, x: 72,  y: 720, width: 40, height: 12 },
    { start: 6,  end: 10, page: 1, x: 118, y: 720, width: 34, height: 12 },
    { start: 11, end: 16, page: 1, x: 72,  y: 700, width: 45, height: 12 },
    { start: 17, end: 22, page: 1, x: 125, y: 700, width: 42, height: 12 },
  ],
};

function fakeSession() {
  const resourceContent = vi.fn(async () => 'alpha beta gamma');
  const resourceRepresentation = vi.fn(async () => ({
    data: new ArrayBuffer(8),
    contentType: 'application/pdf',
  }));
  const session = {
    client: { browse: { resourceContent, resourceRepresentation } },
  } as unknown as SemiontSession;
  return { session, resourceContent, resourceRepresentation };
}

type Sel = { type: string; start?: number; end?: number; value?: string };
const selectors = (ann: Record<string, unknown>): Sel[] =>
  (ann.target as { selector: Sel[] }).selector;

describe('prepareDetection', () => {
  it("'decode': returns the decoded text and a buildAnnotation that anchors by character offsets in that SAME text", async () => {
    const { session, resourceContent, resourceRepresentation } = fakeSession();

    const source = await prepareDetection('decode', session, RID, USER_DID, GENERATOR);

    expect(resourceContent).toHaveBeenCalledOnce();
    expect(resourceRepresentation).not.toHaveBeenCalled();
    expect(source?.text).toBe('alpha beta gamma');

    const ann = source!.buildAnnotation('highlighting', { exact: 'alpha', start: 0, end: 5 }) as Record<string, unknown>;
    expect(ann.motivation).toBe('highlighting');
    expect((ann.target as { source: string }).source).toBe(RID);
    const sels = selectors(ann);
    expect(sels.find((s) => s.type === 'TextPositionSelector')).toMatchObject({ start: 0, end: 5 });
    expect(sels.some((s) => s.type === 'TextQuoteSelector')).toBe(true);
    // The closure closed over the decoded text: a span that does not match it
    // trips buildTextAnnotation's content invariant.
    expect(() => source!.buildAnnotation('highlighting', { exact: 'zzz', start: 0, end: 3 })).toThrow(/invariant/);
  });

  it("'pdf-text-layer': fetches the representation bytes and anchors by viewrect geometry from the SAME layer", async () => {
    const { session, resourceContent, resourceRepresentation } = fakeSession();
    vi.mocked(extractPdfTextLayer).mockResolvedValue(LAYER);

    const source = await prepareDetection('pdf-text-layer', session, RID, USER_DID, GENERATOR);

    expect(resourceRepresentation).toHaveBeenCalledOnce();
    expect(resourceContent).not.toHaveBeenCalled();
    expect(source?.text).toBe(LAYER.text);

    const ann = source!.buildAnnotation('highlighting', { exact: 'alpha', start: 0, end: 5 }) as Record<string, unknown>;
    const sels = selectors(ann);
    expect(sels.find((s) => s.type === 'FragmentSelector')?.value).toMatch(/^page=1&viewrect=/);
    expect(sels.some((s) => s.type === 'TextPositionSelector')).toBe(false);
    expect(sels.some((s) => s.type === 'TextQuoteSelector')).toBe(true);
  });

  it("'pdf-text-layer': returns null for a scanned / image-only PDF (no text layer)", async () => {
    const { session } = fakeSession();
    vi.mocked(extractPdfTextLayer).mockResolvedValue(null);

    expect(await prepareDetection('pdf-text-layer', session, RID, USER_DID, GENERATOR)).toBeNull();
  });

  it("'none': returns null without touching the session", async () => {
    const { session, resourceContent, resourceRepresentation } = fakeSession();

    expect(await prepareDetection('none', session, RID, USER_DID, GENERATOR)).toBeNull();
    expect(resourceContent).not.toHaveBeenCalled();
    expect(resourceRepresentation).not.toHaveBeenCalled();
  });
});
