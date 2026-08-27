/**
 * EXTRACT-ARCHIVIST P1 — the decoupling proof.
 *
 * Each Archivist actor (Stower, Browser, CloneTokenManager) constructs from
 * narrow capability doubles. `KnowledgeBase` appears nowhere in this file —
 * that absence IS the test: if an actor can be built and exercised without
 * the god-object, it is decoupled. These tests drive the boundary in and pin
 * it afterwards.
 *
 * The capability shapes are the actors' honest surfaces, measured 2026-08-27:
 * - Stower: content lifecycle {register, move, remove, resolveUri} (D4a's
 *   split — no byte service) + appendEvent + project.projectionsDir.
 * - Browser: read-only slices — views, event-log reads + materializer,
 *   graph reads, vector search, content.retrieve, anchoredText, the smelt
 *   barrier.
 * - CloneTokenManager: views.get + {store, resolveUri}. Its old
 *   `retrieve()`-as-existence-check was a full file read to answer a
 *   boolean; the boundary replaces it with resolveUri + stat (D4a).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { firstValueFrom, race, timeout, filter, map, type Observable } from 'rxjs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { EventBus, resourceId as makeResourceId, type Logger } from '@semiont/core';
import { writeStorageUriEntry } from '@semiont/event-sourcing';
import { Stower, STOWER_CHANNELS, type StowerStores } from '../stower';
import { Browser, BROWSER_CHANNELS, type BrowserReads } from '../browser';
import { CloneTokenManager, CLONE_TOKEN_CHANNELS, type CloneTokenStores } from '../clone-token-manager';
import { createTestProject, type TestProject } from './helpers/test-project';
import { createMockEmbeddingProvider } from './helpers/smelter-harness';
import type { MakeMeaningConfig } from '../config';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

/** Await one correlated reply, failing loudly on the paired failure event. */
function reply<Ok extends { correlationId?: string }>(
  ok$: Observable<Ok>,
  failed$: Observable<{ correlationId?: string; message?: string }>,
  correlationId: string,
): Promise<Ok> {
  return firstValueFrom(
    race(
      ok$.pipe(filter((e) => e.correlationId === correlationId)),
      failed$.pipe(
        filter((e) => e.correlationId === correlationId),
        map((e): never => {
          throw new Error(`failure reply: ${e.message}`);
        }),
      ),
    ).pipe(timeout(3000)),
  );
}

// ── Stower ────────────────────────────────────────────────────────────────────

describe('Stower constructs from capability doubles (EXTRACT-ARCHIVIST P1)', () => {
  let tp: TestProject;
  let eventBus: EventBus;
  let stower: Stower;

  function makeStores() {
    const stores = {
      content: {
        register: vi.fn().mockResolvedValue({ storageUri: 'file:///x', checksum: 'sha-registered', byteSize: 5 }),
        move: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        resolveUri: vi.fn((uri: string) => uri.replace('file://', '')),
      },
      eventStore: {
        appendEvent: vi.fn().mockResolvedValue({}),
      },
    } satisfies StowerStores;
    return stores;
  }

  afterEach(async () => {
    await stower.stop();
    eventBus.destroy();
    await tp.teardown();
  });

  it('yield:create registers content and appends yield:created — no KnowledgeBase', async () => {
    tp = await createTestProject('stower-doubles');
    eventBus = new EventBus();
    const stores = makeStores();
    stower = new Stower(stores, eventBus, tp.project, mockLogger);
    await stower.initialize();

    const correlationId = 'p1-create-1';
    const ok = reply(eventBus.get('yield:create-ok'), eventBus.get('yield:create-failed'), correlationId);

    eventBus.get('yield:create').next({
      correlationId,
      _userId: 'user-1',
      name: 'doc.txt',
      format: 'text/plain',
      storageUri: 'file:///tmp/doc.txt',
      contentChecksum: 'sha-in',
      byteSize: 5,
    });

    const result = await ok;
    expect(result.response.resourceId).toBeTruthy();
    expect(stores.content.register).toHaveBeenCalledWith('file:///tmp/doc.txt', 'sha-in', { noGit: undefined });
    expect(stores.eventStore.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'yield:created' }),
    );
  });

  it('yield:mv resolves the resource through project.projectionsDir, not a kb path', async () => {
    tp = await createTestProject('stower-doubles-mv');
    eventBus = new EventBus();
    const stores = makeStores();
    stower = new Stower(stores, eventBus, tp.project, mockLogger);
    await stower.initialize();

    // Seed the storage-uri index the way the materializer would.
    const rid = makeResourceId('res-mv-1');
    const fromUri = 'file:///tmp/from.txt';
    await fs.mkdir(tp.project.projectionsDir, { recursive: true });
    await writeStorageUriEntry(tp.project.projectionsDir, fromUri, rid);

    // The success signal is the yield:moved DOMAIN event, which the real
    // appendEvent publishes — our double doesn't, so the double's calls are
    // the observable outcome. A failure reply is captured and asserted flat.
    let failure: string | undefined;
    const failSub = eventBus.get('yield:move-failed').subscribe((e) => {
      failure = e.message;
    });

    eventBus.get('yield:mv').next({
      _userId: 'user-1',
      fromUri,
      toUri: 'file:///tmp/to.txt',
    });

    await vi.waitFor(() => {
      expect(failure).toBeUndefined();
      expect(stores.content.move).toHaveBeenCalledWith(fromUri, 'file:///tmp/to.txt', { noGit: undefined });
      expect(stores.eventStore.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'yield:moved', resourceId: rid }),
      );
    });
    failSub.unsubscribe();
  });

  it('mark:archive removes content then appends mark:archived', async () => {
    tp = await createTestProject('stower-doubles-archive');
    eventBus = new EventBus();
    const stores = makeStores();
    stower = new Stower(stores, eventBus, tp.project, mockLogger);
    await stower.initialize();

    const correlationId = 'p1-archive-1';
    const ok = reply(eventBus.get('mark:archive-ok'), eventBus.get('mark:archive-failed'), correlationId);

    eventBus.get('mark:archive').next({
      correlationId,
      _userId: 'user-1',
      resourceId: 'res-arch-1',
      storageUri: 'file:///tmp/gone.txt',
      keepFile: true,
    });

    await ok;
    expect(stores.content.remove).toHaveBeenCalledWith('file:///tmp/gone.txt', { keepFile: true, noGit: undefined });
    expect(stores.eventStore.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mark:archived' }),
    );
  });
});

// ── Browser ───────────────────────────────────────────────────────────────────

describe('Browser constructs from capability doubles (EXTRACT-ARCHIVIST P1)', () => {
  const PROJECT_ROOT = '/home/user/archivist-p1';
  const config: MakeMeaningConfig = {
    services: { vectors: { type: 'memory' }, embedding: { type: 'ollama', model: 'nomic-embed-text' } },
    gather: { settleTimeoutMs: 15_000 },
    search: { semanticFloor: 0.6 },
  };
  const passthroughDiscovery = { enrich: async (entries: any[]) => entries };

  let eventBus: EventBus;
  let browser: Browser;

  function makeReads(overrides: Partial<BrowserReads> = {}): BrowserReads {
    return {
      views: {
        get: vi.fn().mockResolvedValue(null),
        getAll: vi.fn().mockResolvedValue([]),
        exists: vi.fn().mockResolvedValue(false),
      },
      eventStore: {
        log: {
          storage: {
            getAllEvents: vi.fn().mockResolvedValue([]),
            getEventFiles: vi.fn().mockResolvedValue([]),
            getLastEvent: vi.fn().mockResolvedValue(null),
          },
        },
        views: {
          materializer: { materialize: vi.fn().mockResolvedValue(null) },
        },
      },
      graph: {
        getResource: vi.fn().mockResolvedValue(null),
        getResourceReferencedBy: vi.fn().mockResolvedValue([]),
        listResources: vi.fn().mockResolvedValue({ resources: [], total: 0 }),
        getEntityTypeStats: vi.fn().mockResolvedValue([]),
      },
      vectors: {
        searchResources: vi.fn().mockResolvedValue([]),
        searchAnnotations: vi.fn().mockResolvedValue([]),
      },
      content: { retrieve: vi.fn().mockResolvedValue(Buffer.from('')) },
      anchoredText: { read: vi.fn().mockResolvedValue(null) },
      smeltProgress: { whenSettled: vi.fn().mockResolvedValue('indexed') },
      ...overrides,
    };
  }

  async function start(reads: BrowserReads) {
    eventBus = new EventBus();
    browser = new Browser(
      reads,
      eventBus,
      { root: PROJECT_ROOT } as never,
      config,
      passthroughDiscovery,
      createMockEmbeddingProvider(),
      mockLogger,
    );
    await browser.initialize();
  }

  afterEach(async () => {
    await browser.stop();
    eventBus.destroy();
  });

  it('browse:annotations-requested answers from the views slice — no KnowledgeBase', async () => {
    const rid = makeResourceId('res-b1');
    const annotation = {
      id: 'anno-1',
      motivation: 'commenting',
      target: { source: String(rid) },
      body: [],
    };
    const reads = makeReads();
    (reads.views.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      resource: { '@id': String(rid), name: 'Doc' },
      annotations: { resourceId: rid, version: 1, updatedAt: 't', annotations: [annotation] },
    });
    await start(reads);

    const correlationId = 'p1-annos-1';
    const ok = reply(eventBus.get('browse:annotations-result'), eventBus.get('browse:annotations-failed'), correlationId);

    eventBus.get('browse:annotations-requested').next({ correlationId, resourceId: String(rid) });

    const result = await ok;
    expect(result.response.total).toBe(1);
    expect(reads.views.get).toHaveBeenCalled();
  });

  it('browse:resource-requested assembles from event-log reads + the materializer slice', async () => {
    const rid = makeResourceId('res-b2');
    const reads = makeReads();
    (reads.eventStore.log.storage.getAllEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
      { type: 'yield:created', payload: {}, metadata: { sequenceNumber: 1 } },
    ]);
    (reads.eventStore.views.materializer.materialize as ReturnType<typeof vi.fn>).mockResolvedValue({
      resource: { '@id': String(rid), name: 'Assembled' },
      annotations: { resourceId: rid, version: 1, updatedAt: 't', annotations: [] },
    });
    await start(reads);

    const correlationId = 'p1-res-1';
    const ok = reply(eventBus.get('browse:resource-result'), eventBus.get('browse:resource-failed'), correlationId);

    eventBus.get('browse:resource-requested').next({ correlationId, resourceId: String(rid) });

    const result = await ok;
    expect(result.response.resource.name).toBe('Assembled');
    expect(reads.eventStore.views.materializer.materialize).toHaveBeenCalled();
  });

  it('browse:referenced-by-requested walks the graph slice with view grace', async () => {
    const target = makeResourceId('res-b3');
    const citer = makeResourceId('res-citer');
    const reads = makeReads();
    (reads.graph.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'anno-ref-1',
        target: { source: String(citer), selector: { type: 'TextQuoteSelector', exact: 'quoted words' } },
      },
    ]);
    (reads.graph.getResource as ReturnType<typeof vi.fn>).mockResolvedValue({
      '@id': String(citer),
      name: 'Citing Doc',
    });
    await start(reads);

    const correlationId = 'p1-refby-1';
    const ok = reply(eventBus.get('browse:referenced-by-result'), eventBus.get('browse:referenced-by-failed'), correlationId);

    eventBus.get('browse:referenced-by-requested').next({ correlationId, resourceId: String(target) });

    const result = await ok;
    expect(result.response.referencedBy).toHaveLength(1);
    expect(result.response.referencedBy[0].resourceName).toBe('Citing Doc');
  });
});

// ── CloneTokenManager ─────────────────────────────────────────────────────────

describe('CloneTokenManager constructs from capability doubles (EXTRACT-ARCHIVIST P1)', () => {
  let tmpFile: string;
  let eventBus: EventBus;
  let ctm: CloneTokenManager;

  afterEach(async () => {
    await ctm.stop();
    eventBus.destroy();
    await fs.rm(tmpFile, { force: true });
  });

  it('generates a clone token via resolveUri + stat — never a byte retrieve (D4a)', async () => {
    const rid = makeResourceId('res-clone-1');
    tmpFile = join(process.env.TMPDIR ?? '/tmp', `archivist-p1-clone-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, 'clone me');

    const stores = {
      views: {
        get: vi.fn().mockResolvedValue({
          resource: {
            '@id': String(rid),
            name: 'Source',
            storageUri: `file://${tmpFile}`,
            representations: [{ mediaType: 'text/plain', checksum: 'c1' }],
          },
          annotations: { resourceId: rid, version: 1, updatedAt: 't', annotations: [] },
        }),
      },
      content: {
        store: vi.fn().mockResolvedValue({ storageUri: 'file:///new', checksum: 'sha-new', byteSize: 8 }),
        resolveUri: vi.fn(() => tmpFile),
      },
    } satisfies CloneTokenStores;

    eventBus = new EventBus();
    ctm = new CloneTokenManager(stores, eventBus, mockLogger);
    await ctm.initialize();

    const correlationId = 'p1-token-1';
    const ok = reply(eventBus.get('yield:clone-token-generated'), eventBus.get('yield:clone-token-failed'), correlationId);

    eventBus.get('yield:clone-token-requested').next({ correlationId, resourceId: String(rid) });

    const result = await ok;
    expect(result.response.token).toMatch(/^clone_/);
    expect(result.response.resource.name).toBe('Source');
    expect(stores.content.resolveUri).toHaveBeenCalledWith(`file://${tmpFile}`);
    // The boundary is the assertion: the stores expose no `retrieve` at all,
    // so an existence check that reads bytes cannot compile against them.
  });

  it('answers yield:clone-resource-requested from the held token', async () => {
    const rid = makeResourceId('res-clone-2');
    tmpFile = join(process.env.TMPDIR ?? '/tmp', `archivist-p1-clone2-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, 'clone me too');

    const stores = {
      views: {
        get: vi.fn().mockResolvedValue({
          resource: { '@id': String(rid), name: 'Held', storageUri: `file://${tmpFile}` },
          annotations: { resourceId: rid, version: 1, updatedAt: 't', annotations: [] },
        }),
      },
      content: {
        store: vi.fn(),
        resolveUri: vi.fn(() => tmpFile),
      },
    } satisfies CloneTokenStores;

    eventBus = new EventBus();
    ctm = new CloneTokenManager(stores, eventBus, mockLogger);
    await ctm.initialize();

    const tokenCid = 'p1-token-2';
    const token$ = reply(eventBus.get('yield:clone-token-generated'), eventBus.get('yield:clone-token-failed'), tokenCid);
    eventBus.get('yield:clone-token-requested').next({ correlationId: tokenCid, resourceId: String(rid) });
    const { response: { token } } = await token$;

    const getCid = 'p1-get-1';
    const got$ = reply(eventBus.get('yield:clone-resource-result'), eventBus.get('yield:clone-resource-failed'), getCid);
    eventBus.get('yield:clone-resource-requested').next({ correlationId: getCid, token });

    const { response } = await got$;
    expect(response.sourceResource.name).toBe('Held');
  });
});

// ── Channel roster census gates ───────────────────────────────────────────────
//
// archivist-main derives its SSE subscription from the exported *_CHANNELS
// rosters. These gates pin each roster to the actor's ACTUAL subscriptions:
// add a subscription without growing the roster (or vice versa) and the gate
// fails — the mirror cannot drift silently.

describe('channel rosters match actual subscriptions (census gate)', () => {
  async function subscribedChannels(initialize: (bus: EventBus) => Promise<{ stop(): Promise<void> }>) {
    const bus = new EventBus();
    const seen: string[] = [];
    const realGet = bus.get.bind(bus);
    // Shadow the prototype method on the instance: initialize() only calls
    // get() to subscribe, so the recorded names ARE the subscription census.
    bus.get = ((channel) => {
      seen.push(channel as string);
      return realGet(channel);
    }) as typeof bus.get;
    const actor = await initialize(bus);
    await actor.stop();
    bus.destroy();
    return new Set(seen);
  }

  it('Stower', async () => {
    const tp = await createTestProject('stower-census');
    try {
      const channels = await subscribedChannels(async (bus) => {
        const stower = new Stower(
          {
            content: { register: vi.fn(), move: vi.fn(), remove: vi.fn(), resolveUri: vi.fn() },
            eventStore: { appendEvent: vi.fn() },
          },
          bus, tp.project, mockLogger,
        );
        await stower.initialize();
        return stower;
      });
      expect(channels).toEqual(new Set(STOWER_CHANNELS));
    } finally {
      await tp.teardown();
    }
  });

  it('Browser', async () => {
    const channels = await subscribedChannels(async (bus) => {
      const browser = new Browser(
        {
          views: { get: vi.fn(), getAll: vi.fn(), exists: vi.fn() },
          eventStore: {
            log: { storage: { getAllEvents: vi.fn(), getEventFiles: vi.fn(), getLastEvent: vi.fn() } },
            views: { materializer: { materialize: vi.fn() } },
          },
          graph: { getResource: vi.fn(), getResourceReferencedBy: vi.fn(), listResources: vi.fn(), getEntityTypeStats: vi.fn() },
          vectors: { searchResources: vi.fn(), searchAnnotations: vi.fn() },
          content: { retrieve: vi.fn() },
          anchoredText: { read: vi.fn() },
          smeltProgress: { whenSettled: vi.fn() },
        },
        bus,
        { root: '/tmp/census' } as never,
        { services: { vectors: { type: 'memory' }, embedding: { type: 'ollama', model: 'nomic-embed-text' } }, gather: { settleTimeoutMs: 15_000 }, search: { semanticFloor: 0.6 } },
        { enrich: async (entries: never[]) => entries },
        createMockEmbeddingProvider(),
        mockLogger,
      );
      await browser.initialize();
      return browser;
    });
    expect(channels).toEqual(new Set(BROWSER_CHANNELS));
  });

  it('CloneTokenManager', async () => {
    const channels = await subscribedChannels(async (bus) => {
      const ctm = new CloneTokenManager(
        { views: { get: vi.fn() }, content: { store: vi.fn(), resolveUri: vi.fn() } },
        bus, mockLogger,
      );
      await ctm.initialize();
      return ctm;
    });
    expect(channels).toEqual(new Set(CLONE_TOKEN_CHANNELS));
  });
});
