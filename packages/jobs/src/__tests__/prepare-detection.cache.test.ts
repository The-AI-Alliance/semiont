/**
 * prepareDetection × ExtractionCache — PERSIST-ANCHORS P2d.
 *
 * The sibling suite (`prepare-detection.test.ts`) is the dispatch layer:
 * it stubs the PDF extractor slot and proves the anchoring model follows
 * the geometry. This suite is the layer below: the REAL extractor
 * registry, so the cache seam inside `extract()` is the thing under test
 * — do not add a `@semiont/content` module mock here.
 *
 * Detection is the second genuine consumer of the anchored-text artifact
 * (the smelter is the first), and the one whose offsets the Class C
 * two-writers collision would have corrupted: a cached base-0 OCR
 * fragment re-shifted by the native length anchored quotes to the wrong
 * place, silently. P2b killed the fragment writer at the source; these
 * tests prove the fix from the consumer side, per the plan's RED
 * assignment:
 *
 *  - a stored hybrid (Class C) outcome is served WHOLE, and a span inside
 *    its OCR block anchors to the geometry the record claims —
 *    `buildPdfAnnotation`'s covered-text invariant is the teeth;
 *  - a second pass over the same bytes is served from the store — proven
 *    with a sentinel swap, not wall clock: if extraction had re-run, the
 *    text would be the PDF's own, so the sentinel is airtight proof that
 *    neither the parser nor the engine ran (the plan's own warning about
 *    timing assertions);
 *  - a stored decline is a hit too (D1: declines cacheable) — the second
 *    look at an unreadable scan costs no recognition pass.
 *
 * The store double is in-memory; the key contract is the P1c rule — the
 * checksum of the bytes actually fetched, never a descriptor claim.
 */

import { describe, it, expect, vi } from 'vitest';
import { resourceId, type ExtractionOutcome, type PdfTextItem, type components } from '@semiont/core';
import { calculateChecksum, type AnchoredTextStore, type ContentReads } from '@semiont/content';
import { prepareDetection } from '../workers/detection/prepare-detection';

type Agent = components['schemas']['Agent'];

const RID = resourceId('res-p2d');
const USER = 'did:web:test.local:users:alice%40test.local';
const GENERATOR: Agent = {
  '@type': 'Software',
  '@id': 'did:web:test.local:agents:test:test',
  name: 'test test',
  provider: 'test',
  model: 'test',
} as Agent;

function memoryStore(seed: Record<string, ExtractionOutcome> = {}) {
  const entries = new Map<string, ExtractionOutcome>(Object.entries(seed));
  const store: AnchoredTextStore = {
    read: async (key) => entries.get(key) ?? null,
    write: async (key, outcome) => {
      entries.set(key, outcome);
    },
    list: async () => [...entries.keys()],
  };
  return { store, entries };
}

/**
 * The byte read, serving exactly these bytes for any resource.
 *
 * Copied into a fresh ArrayBuffer rather than sliced off `bytes.buffer`: the
 * slice is typed `ArrayBuffer | SharedArrayBuffer`, which the transport
 * contract does not accept. The old double hid that behind a cast to a
 * hollowed-out session; taking the read seam directly (SINGLE-KB-MOUNT P4)
 * left nowhere for it to hide.
 */
function readsServing(bytes: Buffer): ContentReads {
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  return { getBinary: vi.fn(async () => ({ data, contentType: 'application/pdf' })) };
}

/** One PdfTextItem per word of `block`, offsets global (shifted by `base`). */
function itemsFor(block: string, base: number, page: number): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(block)) !== null) {
    items.push({
      start: base + m.index,
      end: base + m.index + m[0].length,
      page,
      x: 20 + (i % 8) * 60,
      y: 700 - Math.floor(i / 8) * 16,
      width: m[0].length * 6,
      height: 12,
    });
    i++;
  }
  return items;
}

// The Class C shape: a native text layer, plus an OCR'd block appended with
// every offset shifted by the native length — the CORRECT whole-outcome
// record (what the extract() seam stores post-D1). The old fragment writer
// stored this block base-0; a reader re-shifting it produced the
// double-shifted offsets this suite exists to prove gone.
const NATIVE = 'Native text layer discussing semiotics at length. ';
const OCR = 'Worker liveness proven by heartbeat progress signals.';
const HYBRID_TEXT = NATIVE + OCR;
const HYBRID_ITEMS = itemsFor(OCR, NATIVE.length, 2);

const BODY = [
  { type: 'TextualBody' as const, value: 'note', purpose: 'commenting' as const, format: 'text/plain' },
];

describe('prepareDetection × ExtractionCache (PERSIST-ANCHORS P2d)', () => {
  it('serves a stored Class C outcome whole — a span in the OCR block anchors to the geometry the record claims', async () => {
    // Deliberately unparseable bytes: on a true hit nothing ever looks at
    // them, and on a regression (cache unwired / partial hit) extraction
    // declines and the assertions below fail loudly.
    const bytes = Buffer.from('not a pdf at all — the store must answer');
    const outcome: ExtractionOutcome = {
      text: HYBRID_TEXT,
      items: HYBRID_ITEMS,
      method: 'ocr',
      pdfClass: 'C',
    } as ExtractionOutcome;
    const { store } = memoryStore({ [calculateChecksum(bytes)]: outcome });

    const source = await prepareDetection('application/pdf', readsServing(bytes), RID, USER, GENERATOR, store);

    expect('declined' in source).toBe(false);
    if ('declined' in source) return;

    // The stored text, verbatim — extraction did not run.
    expect(source.text).toBe(HYBRID_TEXT);

    // Anchor a span inside the OCR block. Under double-shifted offsets the
    // span overlaps no item (or the wrong ones) and buildPdfAnnotation's
    // covered-text invariant throws; under the whole-record contract it
    // anchors to the claimed geometry on the claimed page.
    const start = HYBRID_TEXT.indexOf('heartbeat');
    const ann = source.buildAnnotation(
      'commenting',
      { exact: 'heartbeat', start, end: start + 'heartbeat'.length },
      BODY,
    ) as { target?: { selector?: Array<{ type?: string; value?: string }> } };

    const sels = ann.target?.selector ?? [];
    expect(sels.length).toBeGreaterThan(0);
    expect(sels.find((s) => s.type === 'FragmentSelector')?.value).toMatch(/^page=2&viewrect=/);
  });

  it('second pass over the same bytes is served from the store — no re-extraction (the P2 acceptance, sentinel-proven)', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Alpha beta gamma delta epsilon.', { x: 20, y: 150, size: 12, font });
    const pdf = Buffer.from(await doc.save());
    const key = calculateChecksum(pdf);

    const { store, entries } = memoryStore();

    // Pass 1: real extraction, and the seam records its outcome under the
    // checksum of the bytes actually read.
    const first = await prepareDetection('application/pdf', readsServing(pdf), RID, USER, GENERATOR, store);
    expect('declined' in first).toBe(false);
    expect(entries.has(key)).toBe(true);

    // Sentinel swap: if pass 2 re-ran the parser or the engine, it would
    // return the PDF's own text, not this.
    const stored = entries.get(key)!;
    entries.set(key, { ...stored, text: 'SENTINEL-FROM-STORE', items: [] } as ExtractionOutcome);

    const second = await prepareDetection('application/pdf', readsServing(pdf), RID, USER, GENERATOR, store);
    expect('declined' in second).toBe(false);
    if ('declined' in second) return;
    expect(second.text).toBe('SENTINEL-FROM-STORE');
  });

  it('a stored decline is a hit — the second look at an unreadable scan runs nothing (D1: declines cacheable)', async () => {
    const bytes = Buffer.from('scanned pixels, no text layer');
    const { store } = memoryStore({
      [calculateChecksum(bytes)]: { kind: 'declined', declined: 'no-text-layer' },
    });

    const source = await prepareDetection('application/pdf', readsServing(bytes), RID, USER, GENERATOR, store);

    expect(source).toEqual({ kind: 'declined', declined: 'no-text-layer' });
  });
});
