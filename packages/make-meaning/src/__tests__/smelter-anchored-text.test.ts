/**
 * The Smelter publishes the coordinate map it derived — ANCHORED-TEXT-CACHE
 * Lane 5, producer side.
 *
 * The Smelter is the only process that reads a resource's bytes at ingest, so it
 * is the only one positioned to produce a map cheaply: it has already decoded
 * the document and run the engine in order to embed. Every other consumer — five
 * detection jobs and the browser — arrives later and would have to redo all of
 * it. Publishing here is what turns that one pass into the only pass.
 *
 * Through `IContentTransport`, not a shared volume: the KnowledgeSystem owns
 * storage and the Smelter is a separate process.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { EMPTY, Subject } from 'rxjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { calculateChecksum } from '@semiont/content';
import { MemoryVectorStore } from '@semiont/vectors';
import type { AnchoredText, IContentTransport, Logger } from '@semiont/core';
import { Smelter } from '../smelter';
import type { SmelterEvent } from '../smelter-actor-state-unit';
import {
  createMockEmbeddingProvider,
  createContentTransport,
  createFakeKsBus,
  resourceDescriptor,
} from './helpers/smelter-harness';

const mockLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: () => mockLogger,
};

const RID = 'res-anchored';

/**
 * A one-line native PDF. Text has no coordinate map — it anchors by character
 * offset — so proving the Smelter publishes one needs a document whose
 * extraction actually carries `items`.
 */
let PDF_BYTES: Uint8Array;
beforeAll(async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('alpha beta gamma', { x: 72, y: 720, size: 12, font });
  PDF_BYTES = await doc.save();
});

/**
 * A content transport that serves one document and records every published map.
 * `putAnchoredText` is the method under test; everything else is the existing
 * harness behaviour.
 */
function transportRecording(
  put: (checksum: string, anchored: AnchoredText) => void,
  entry: { text: string; mediaType: string } | { bytes: Uint8Array; mediaType: string },
): IContentTransport {
  const base = createContentTransport({ read: (rid) => (rid === RID ? entry : undefined) });
  return { ...base, putAnchoredText: async (checksum, anchored) => { put(checksum, anchored); } };
}

async function smelterOver(content: IContentTransport, mediaType = 'text/plain') {
  const events$ = new Subject<SmelterEvent>();
  const vectorStore = new MemoryVectorStore();
  await vectorStore.connect();
  const smelter = new Smelter(
    events$,
    EMPTY,
    vectorStore,
    createMockEmbeddingProvider(),
    content,
    createFakeKsBus([resourceDescriptor(RID, mediaType)]),
    { chunkSize: 512, overlap: 64 },
    { burstWindowMs: 5, maxBatchSize: 100, idleTimeoutMs: 20 },
    mockLogger,
  );
  smelter.initialize();
  return { smelter, events$, settle: () => new Promise((r) => setTimeout(r, 300)) };
}

describe('Smelter publishes derived anchored text', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes the map for a resource whose extraction carried geometry', async () => {
    const put = vi.fn();
    const { events$, settle } = await smelterOver(
      transportRecording(put, { bytes: PDF_BYTES, mediaType: 'application/pdf' }),
      'application/pdf',
    );

    events$.next({ type: 'smelt:embed', resourceId: RID, payload: {} });
    await settle();

    expect(put).toHaveBeenCalledTimes(1);
    const [key, map] = put.mock.calls[0] as [string, AnchoredText];
    // Filed under the checksum of the bytes the producer read (P1b), never
    // the mutable resource id.
    expect(key).toBe(calculateChecksum(Buffer.from(PDF_BYTES)));
    expect(map.text).toContain('alpha');
    // Geometry, not just text — the whole reason a consumer wants this.
    expect(map.items.length).toBeGreaterThan(0);
    expect(map.items[0]).toMatchObject({ page: 1 });
  });

  it('publishes nothing for an extraction with no geometry', async () => {
    // Plain text anchors by character offset and carries no `items`. Writing an
    // empty map would give every text resource in the knowledge base a useless
    // record.
    const put = vi.fn();
    const { events$, settle } = await smelterOver(
      transportRecording(put, { text: 'no geometry here', mediaType: 'text/plain' }),
    );

    events$.next({ type: 'smelt:embed', resourceId: RID, payload: {} });
    await settle();

    expect(put).not.toHaveBeenCalled();
  });

  it('does not fail the index when publishing the map throws', async () => {
    // The map is an optimization; the embedding is the job. A storage failure
    // must not turn a successful index into a skip — that would hide the
    // resource from search over a cache write.
    const base = createContentTransport({
      read: (rid) => (rid === RID ? { text: 'alpha beta', mediaType: 'text/plain' } : undefined),
    });
    const content: IContentTransport = {
      ...base,
      putAnchoredText: async () => { throw new Error('store unavailable'); },
    };
    const { events$, settle } = await smelterOver(content);

    events$.next({ type: 'smelt:embed', resourceId: RID, payload: {} });
    await settle();

    expect(vi.mocked(mockLogger.error)).not.toHaveBeenCalled();
  });
});
