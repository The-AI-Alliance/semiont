/**
 * `readAnchoredText` and the anchored-text store, tested directly.
 *
 * The Smelter derives a coordinate map at ingest; detection jobs and the
 * browser read it. This file pins how a READER resolves one — in particular
 * that it can never receive geometry for bytes the resource no longer has.
 *
 * These tests used to reach their subjects through four `IContentTransport`
 * methods (`putAnchoredText`, `getAnchoredText`, …). Those were one-line
 * wrappers, and SMELTER-OWNS-OCR P0 deleted them: anchored text moved onto bus
 * channels (ANCHORED-TEXT-TO-SMELTER P3/P4), so the transport-layer twins had
 * no callers and, on the HTTP side, no route behind them. The wrappers are
 * gone; the invariants they happened to cover are these, now asserted against
 * `readAnchoredText` and `kb.anchoredText` themselves — which is what they
 * were always about.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

import { EventBus, getPrimaryRepresentation, userId as makeUserId, type ExtractionOutcome, type Logger, type ResourceId } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
import { readAnchoredText } from '../read-anchored-text';
import { ResourceOperations } from '../resource-operations';
import { startMakeMeaning, type MakeMeaningConfig, type MakeMeaningService } from '../service';
import { stubEmbeddingProbeFetch } from './helpers/smelter-harness';

stubEmbeddingProbeFetch();

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: () => silentLogger,
};

const TEST_USER_ID = makeUserId('test-host');

const config: MakeMeaningConfig = {
  gather: { settleTimeoutMs: 15_000 }, search: { semanticFloor: 0.6 },
  services: { graph: { platform: { type: 'posix' }, type: 'memory' }, vectors: { type: 'memory' }, embedding: { type: 'ollama', model: 'nomic-embed-text' } },
  actors: {
    gatherer: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
    matcher: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
  },
  workers: {
    default: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
  },
};

/** One page of recognized words — the shape OCR produces via `mapWordsToItems`. */
const MAP: ExtractionOutcome = {
  kind: 'extracted',
  text: 'alpha beta',
  items: [
    { start: 0, end: 5, page: 1, x: 72, y: 700, width: 28, height: 12 },
    { start: 6, end: 10, page: 1, x: 106, y: 700, width: 22, height: 12 },
  ],
  method: 'ocr',
};

describe('readAnchoredText + the anchored-text store', () => {
  let service: MakeMeaningService;
  /** The KnowledgeSystem the reader resolves against — views + the store. */
  let kb: MakeMeaningService['knowledgeSystem']['kb'];
  let eventBus: EventBus;
  let testDir: string;
  let rid: ResourceId;
  let checksum: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-anchored-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    eventBus = new EventBus();
    service = await startMakeMeaning(new SemiontProject(testDir, { anchoredTextDir: `${testDir}/anchored-text` }), config, eventBus, silentLogger);
    kb = service.knowledgeSystem.kb;

    ({ rid, checksum } = await seedPdf('scan'));
  }, 30_000);

  /**
   * Seed a resource AND announce that the Smelter has settled it.
   *
   * The read applies a read-your-writes barrier: a miss waits for the Smelter
   * to finish *this* content generation rather than reporting "no map" for a
   * document still being read. No Smelter runs in this harness, so without the
   * signal every miss would block for the full timeout — which is the barrier
   * working, not a bug.
   */
  async function seedPdf(name: string, outcome: 'indexed' | 'skipped' = 'indexed'): Promise<{ rid: ResourceId; checksum: string }> {
    const buf = Buffer.from(`${name} — a scanned page`, 'utf-8');
    const stored = await service.knowledgeSystem.kb.content.store(buf, `file://${name}-${uuidv4()}.pdf`);
    const rid = await ResourceOperations.createResource(
      {
        name,
        storageUri: stored.storageUri,
        contentChecksum: stored.checksum,
        byteSize: stored.byteSize,
        format: 'application/pdf' as 'text/plain',
      },
      TEST_USER_ID,
      eventBus,
    );
    eventBus.get('smelt:settled').next({
      resourceId: String(rid),
      contentChecksum: stored.checksum,
      outcome,
    });
    return { rid, checksum: stored.checksum };
  }

  afterAll(async () => {
    await service?.stop?.();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('round-trips a map written by the producer and read by a consumer', async () => {
    // The producer writes by the checksum of the bytes it read (P1b); the
    // reader holds the rid, and the view index resolves it to the same key.
    await kb.anchoredText.write(checksum, MAP);
    expect(await readAnchoredText(kb, String(rid))).toEqual(MAP);
  });

  it('returns null for a resource that has no map', async () => {
    // Not an error. Most resources never have one: a native text layer is read
    // in the browser, and a document with no extractor never produces a map at
    // all. The caller degrades to no quote, which is the pre-existing behaviour.
    const other = await seedPdf('no-map');
    expect(await readAnchoredText(kb, String(other.rid))).toBeNull();
  });

  it('serves the map written last for a resource', async () => {
    // Re-extraction is legitimate — a stamp change, a re-upload, a reconcile.
    // The store holds one map per resource and the newest wins; nothing here
    // accumulates generations.
    const revised: ExtractionOutcome = { kind: 'extracted', text: 'gamma', items: [{ start: 0, end: 5, page: 2, x: 10, y: 20, width: 30, height: 12 }], method: 'ocr' };
    await kb.anchoredText.write(checksum, revised);
    expect(await readAnchoredText(kb, String(rid))).toEqual(revised);
  });

  it('does not serve superseded geometry after the resource\'s bytes change (PERSIST-ANCHORS P1)', async () => {
    // Decision A's failure case, end to end: a map is derived from bytes B1;
    // the resource then gains a new representation (new bytes, new checksum)
    // and drops the old one. The map indexes text that no longer exists —
    // serving it would place quotes at coordinates in the WRONG document,
    // which is worse than absent. The reader must miss.
    const { rid: target } = await seedPdf('mutable');
    const view1 = await kb.views.get(target);
    const c1 = getPrimaryRepresentation(view1?.resource)?.checksum;
    expect(c1).toBeDefined();

    // The producer publishes the map for the B1 bytes it actually read.
    await kb.anchoredText.write(c1!, MAP);
    expect(await readAnchoredText(kb, String(target))).toEqual(MAP);

    // The bytes change: old representation out, new one in — through the
    // single write path (appendEvent), so the view is current by V1.
    const stored2 = await kb.content.store(Buffer.from('mutable — revised scan', 'utf-8'), `file://mutable-rev-${uuidv4()}.pdf`);
    await kb.eventStore.appendEvent({
      type: 'yield:representation-removed',
      resourceId: target, userId: TEST_USER_ID, version: 1,
      payload: { checksum: c1! },
    });
    await kb.eventStore.appendEvent({
      type: 'yield:representation-added',
      resourceId: target, userId: TEST_USER_ID, version: 1,
      payload: { representation: { mediaType: 'application/pdf', storageUri: stored2.storageUri, checksum: stored2.checksum, rel: 'original' } },
    });
    // The new generation has settled (no live Smelter here) — without this the
    // read-your-writes barrier would rightly hold the miss for its timeout.
    eventBus.get('smelt:settled').next({
      resourceId: String(target), contentChecksum: stored2.checksum, outcome: 'indexed',
    });

    expect(await readAnchoredText(kb, String(target))).toBeNull();
  });

  // ── The two barrier-FREE reads (PERSIST-ANCHORS P0 + P2c) ─────────────────
  //
  // `getAnchoredText` above applies a read-your-writes barrier: a miss waits
  // for the Smelter to finish the resource's current content generation. These
  // two deliberately do not, and that asymmetry is the whole point of them
  // being separate methods rather than options on the first.
  //
  // Both tests below therefore emit NO `smelt:settled`. Under the barrier that
  // omission is what makes a miss block for the full timeout — so if either
  // read ever acquires one, these stop returning promptly and start hanging,
  // which is exactly the regression worth catching. The smelter's cache
  // consult runs on every ingest.

  it('reads a map by checksum with no settle barrier — the caller already holds the identity', async () => {
    // Checksum-addressed: no view resolution, nothing to wait for. Written
    // under a checksum belonging to no resource in this KB at all, so a read
    // that resolved views or awaited a generation could not answer it.
    const orphanChecksum = uuidv4().replace(/-/g, '');
    await kb.anchoredText.write(orphanChecksum, MAP);

    expect(await kb.anchoredText.read(orphanChecksum)).toEqual(MAP);
  });

  it('answers null for a checksum nothing has derived, rather than waiting', async () => {
    // The common case at ingest — most content has no map. A miss is an
    // answer here, not a reason to block.
    expect(await kb.anchoredText.read(uuidv4().replace(/-/g, ''))).toBeNull();
  });

  it('lists the store keys for the reconcile diff', async () => {
    // Planning data (P0): presence is being asked, not content at a moment.
    // Written under a REAL content checksum, which is what the planner diffs
    // against — the store shards by key and only entries under the current
    // stamp are listed, so a synthetic key proves nothing about either.
    const { checksum: realChecksum } = await seedPdf('listed');
    await kb.anchoredText.write(realChecksum, MAP);

    const keys = await kb.anchoredText.list();
    expect(keys).toContain(realChecksum);

    // The equivalence the planner depends on: every listed key must read back,
    // or the diff plans re-anchors for artifacts the store already holds.
    for (const key of keys) {
      expect(await kb.anchoredText.read(key)).not.toBeNull();
    }
  });
});
