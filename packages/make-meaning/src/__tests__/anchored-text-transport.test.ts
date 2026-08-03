/**
 * Anchored text over `IContentTransport` — ANCHORED-TEXT-CACHE Lane 5.
 *
 * The Smelter derives a coordinate map at ingest; five detection jobs and a
 * browser all want to read it. This is the seam that carries it, modelled on
 * `getResourceGraph`: a derived, server-computed view of a resource fetched
 * through the content transport, not the resource's bytes.
 *
 * Why a transport method rather than a shared volume between the smelter and
 * worker images: `WorkingTreeStore` is instantiated exactly once, in
 * `knowledge-base.ts`. The KnowledgeSystem owns content storage and every other
 * process reaches it through the transport. A mount would have created a second
 * storage authority, coupled two services through a filesystem, and broken as
 * soon as they landed on different hosts.
 *
 * `putAnchoredText` is its own method rather than a `putBinary` of some derived
 * media type — a coordinate map is not a *representation* of the resource, and
 * dressing it as one would make a derived artifact indistinguishable from
 * content a user uploaded.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

import { EventBus, getPrimaryRepresentation, userId as makeUserId, type AnchoredText, type Logger, type ResourceId } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
import { LocalContentTransport } from '../local-content-transport';
import { ResourceOperations } from '../resource-operations';
import { startMakeMeaning, type MakeMeaningConfig, type MakeMeaningService } from '../service';

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: () => silentLogger,
};

const TEST_USER_ID = makeUserId('test-host');

const config: MakeMeaningConfig = {
  gather: { settleTimeoutMs: 15_000 },
  services: { graph: { platform: { type: 'posix' }, type: 'memory' } },
  actors: {
    gatherer: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
    matcher: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
  },
  workers: {
    default: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
  },
};

/** One page of recognized words — the shape OCR produces via `mapWordsToItems`. */
const MAP: AnchoredText = {
  text: 'alpha beta',
  items: [
    { start: 0, end: 5, page: 1, x: 72, y: 700, width: 28, height: 12 },
    { start: 6, end: 10, page: 1, x: 106, y: 700, width: 22, height: 12 },
  ],
};

describe('anchored text over IContentTransport', () => {
  let service: MakeMeaningService;
  let content: LocalContentTransport;
  let eventBus: EventBus;
  let testDir: string;
  let rid: ResourceId;
  let checksum: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-anchored-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    eventBus = new EventBus();
    service = await startMakeMeaning(new SemiontProject(testDir), config, eventBus, silentLogger);
    content = new LocalContentTransport(service.knowledgeSystem);

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
    await content.putAnchoredText(checksum, MAP);
    expect(await content.getAnchoredText(rid)).toEqual(MAP);
  });

  it('returns null for a resource that has no map', async () => {
    // Not an error. Most resources never have one: a native text layer is read
    // in the browser, and a document with no extractor never produces a map at
    // all. The caller degrades to no quote, which is the pre-existing behaviour.
    const other = await seedPdf('no-map');
    expect(await content.getAnchoredText(other.rid)).toBeNull();
  });

  it('serves the map written last for a resource', async () => {
    // Re-extraction is legitimate — a stamp change, a re-upload, a reconcile.
    // The store holds one map per resource and the newest wins; nothing here
    // accumulates generations.
    const revised: AnchoredText = { text: 'gamma', items: [{ start: 0, end: 5, page: 2, x: 10, y: 20, width: 30, height: 12 }] };
    await content.putAnchoredText(checksum, revised);
    expect(await content.getAnchoredText(rid)).toEqual(revised);
  });

  it('does not serve superseded geometry after the resource\'s bytes change (PERSIST-ANCHORS P1)', async () => {
    // Decision A's failure case, end to end: a map is derived from bytes B1;
    // the resource then gains a new representation (new bytes, new checksum)
    // and drops the old one. The map indexes text that no longer exists —
    // serving it would place quotes at coordinates in the WRONG document,
    // which is worse than absent. The reader must miss.
    const kb = service.knowledgeSystem.kb;
    const { rid: target } = await seedPdf('mutable');
    const view1 = await kb.views.get(target);
    const c1 = getPrimaryRepresentation(view1?.resource)?.checksum;
    expect(c1).toBeDefined();

    // The producer publishes the map for the B1 bytes it actually read.
    await content.putAnchoredText(c1!, MAP);
    expect(await content.getAnchoredText(target)).toEqual(MAP);

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

    expect(await content.getAnchoredText(target)).toBeNull();
  });
});
