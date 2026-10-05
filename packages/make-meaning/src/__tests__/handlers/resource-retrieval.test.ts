/**
 * The Librarian's two retrieval handlers, at the bus:
 * `match:resources-requested` (searching resources by text) and
 * `gather:referenced-by-requested` (what refers to a resource).
 *
 * Both answer from what is derived for finding things — the graph, the
 * vectors, an embedding — so both register beside the Librarian's actors,
 * never in the Archivist.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EventBus,
  SYSTEM_SCOPE,
  resourceId,
  type EventMap,
  type Logger,
  type ResourceDescriptor,
} from '@semiont/core';
import { RETRIEVAL_HANDLER_CHANNELS } from '../../service-channels';
import {
  registerRetrievalHandlers,
  type RetrievalReads,
} from '../../handlers/resource-retrieval';
import { createMockEmbeddingProvider } from '../helpers/smelter-harness';

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => logger),
};

const descriptor = (id: string, name: string, mediaType = 'text/plain'): ResourceDescriptor => ({
  '@context': 'https://schema.org',
  '@id': resourceId(id),
  name,
  representations: [{ mediaType, storageUri: `file://${id}`, checksum: `sum-${id}`, byteSize: 1, rel: 'original' }],
});

const bytes = (text: string): ArrayBuffer => {
  const buf = Buffer.from(text, 'utf8');
  const data = new ArrayBuffer(buf.byteLength);
  new Uint8Array(data).set(buf);
  return data;
};

type Mocks = {
  listResources: ReturnType<typeof vi.fn>;
  getResource: ReturnType<typeof vi.fn>;
  getResourceReferencedBy: ReturnType<typeof vi.fn>;
  viewsGet: ReturnType<typeof vi.fn>;
  searchResources: ReturnType<typeof vi.fn>;
  getBinary: ReturnType<typeof vi.fn>;
};

function mocks(): Mocks {
  return {
    listResources: vi.fn().mockResolvedValue({ resources: [], total: 0 }),
    getResource: vi.fn().mockResolvedValue(null),
    getResourceReferencedBy: vi.fn().mockResolvedValue([]),
    viewsGet: vi.fn().mockResolvedValue(null),
    searchResources: vi.fn().mockResolvedValue([]),
    getBinary: vi.fn().mockResolvedValue({ data: bytes(''), contentType: 'text/plain' }),
  };
}

function readsOf(m: Mocks): RetrievalReads {
  return {
    graph: {
      listResources: m.listResources,
      getResource: m.getResource,
      getResourceReferencedBy: m.getResourceReferencedBy,
    } as RetrievalReads['graph'],
    views: { get: m.viewsGet } as RetrievalReads['views'],
    vectors: { searchResources: m.searchResources } as RetrievalReads['vectors'],
    content: { getBinary: m.getBinary } as RetrievalReads['content'],
  };
}

describe('the Librarian answers retrieval', () => {
  let bus: EventBus;
  let m: Mocks;
  let stateDir: string;
  let stop: () => void;
  let embed: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    bus = new EventBus();
    m = mocks();
    stateDir = await fs.mkdtemp(join(tmpdir(), 'semiont-retrieval-'));
    const embeddingProvider = createMockEmbeddingProvider();
    embed = vi.fn(embeddingProvider.embed.bind(embeddingProvider));
    embeddingProvider.embed = embed as typeof embeddingProvider.embed;
    stop = registerRetrievalHandlers(
      bus,
      readsOf(m),
      { embeddingProvider, semanticFloor: 0.6, state: { stateDir } },
      logger,
    );
  });

  afterEach(async () => {
    stop();
    bus.destroy();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const next = <K extends keyof EventMap>(channel: K) =>
    new Promise<{ payload: EventMap[K]; correlationId?: string }>((resolve) => {
      const sub = bus.frames(channel).subscribe((frame) => {
        sub.unsubscribe();
        resolve(frame);
      });
    });

  describe('match:resources-requested', () => {
    const search = (payload: EventMap['match:resources-requested'], correlationId = 'cid-1') =>
      bus.emit('match:resources-requested', payload, { correlationId });

    it('answers a lexical hit from the graph, with a preview read by resource id', async () => {
      m.listResources.mockResolvedValue({ resources: [descriptor('r1', 'Prometheus Bound')], total: 1 });
      m.getBinary.mockResolvedValue({ data: bytes('Fire was stolen from the gods.'), contentType: 'text/plain' });

      const reply = next('match:resources-result');
      search({ search: 'prometheus', archived: false, entityType: 'Play', limit: 5 });
      const { payload, correlationId } = await reply;

      expect(correlationId).toBe('cid-1');
      expect(m.listResources).toHaveBeenCalledWith({
        search: 'prometheus', archived: false, entityTypes: ['Play'], offset: 0, limit: 5,
      });
      expect(payload.response).toMatchObject({ total: 1, offset: 0, limit: 5, matchKind: 'lexical' });
      expect(payload.response.resources[0]).toMatchObject({ name: 'Prometheus Bound', content: 'Fire was stolen from the gods.' });
      expect(m.getBinary).toHaveBeenCalledWith(resourceId('r1'));
      expect(embed).not.toHaveBeenCalled();
    });

    it('a lexical hit whose text is derived, not decoded, carries no preview and reads no bytes', async () => {
      m.listResources.mockResolvedValue({ resources: [descriptor('pdf1', 'A Scan', 'application/pdf')], total: 1 });

      const reply = next('match:resources-result');
      search({ search: 'scan' });
      const { payload } = await reply;

      expect(payload.response.resources[0]).toMatchObject({ name: 'A Scan', content: '' });
      expect(m.getBinary).not.toHaveBeenCalled();
    });

    it('answers by meaning when nothing matches lexically, and says so', async () => {
      m.searchResources.mockResolvedValue([
        { id: 'v1', score: 0.9, resourceId: resourceId('r2'), text: 'the passage that matched' },
        { id: 'v2', score: 0.2, resourceId: resourceId('r3'), text: 'below the floor' },
      ]);
      m.getResource.mockImplementation(async (id: string) => (id === 'r2' ? descriptor('r2', 'On Fire') : null));

      const reply = next('match:resources-result');
      search({ search: 'theft from heaven' });
      const { payload } = await reply;

      expect(embed).toHaveBeenCalledWith('theft from heaven');
      expect(payload.response.matchKind).toBe('semantic');
      expect(payload.response.total).toBe(1);
      // The passage that matched is the content; a first-200-characters
      // preview must not overwrite it, so no bytes are read.
      expect(payload.response.resources).toEqual([expect.objectContaining({ name: 'On Fire', content: 'the passage that matched' })]);
      expect(m.getBinary).not.toHaveBeenCalled();
    });

    it('a failing fallback is the empty lexical page, never an error', async () => {
      m.searchResources.mockRejectedValue(new Error('qdrant is down'));

      const reply = next('match:resources-result');
      search({ search: 'anything' });
      const { payload } = await reply;

      expect(payload.response).toEqual({ resources: [], total: 0, offset: 0, limit: 50, matchKind: 'lexical' });
    });

    it('a later page of an empty search never asks the embedding', async () => {
      const reply = next('match:resources-result');
      search({ search: 'anything', offset: 50 });
      const { payload } = await reply;

      expect(payload.response.matchKind).toBe('lexical');
      expect(embed).not.toHaveBeenCalled();
    });

    it('blank text matches nothing and asks no store', async () => {
      const reply = next('match:resources-result');
      search({ search: '   ' });
      const { payload } = await reply;

      expect(payload.response).toEqual({ resources: [], total: 0, offset: 0, limit: 50, matchKind: 'lexical' });
      expect(m.listResources).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
    });

    it('a graph that fails answers on the failure channel, under the same key', async () => {
      m.listResources.mockRejectedValue(new Error('neo4j is down'));

      const reply = next('match:resources-failed');
      search({ search: 'prometheus' }, 'cid-9');
      const { payload, correlationId } = await reply;

      expect(correlationId).toBe('cid-9');
      expect(payload.message).toBe('neo4j is down');
    });

    it('names the people its reply mentions, from the people projection', async () => {
      const did = 'did:web:example.org:users:ada';
      await fs.mkdir(join(stateDir, 'projections', SYSTEM_SCOPE), { recursive: true });
      await fs.writeFile(
        join(stateDir, 'projections', SYSTEM_SCOPE, 'people.json'),
        JSON.stringify({ people: { [did]: { name: 'Ada Lovelace' } } }),
      );
      m.listResources.mockResolvedValue({
        resources: [{ ...descriptor('r1', 'Notes'), wasAttributedTo: { '@id': did, '@type': 'Person' } }],
        total: 1,
      });

      const reply = next('match:resources-result');
      search({ search: 'notes' });
      const { payload } = await reply;

      expect(payload.response.resources[0]?.wasAttributedTo).toMatchObject({ '@id': did, name: 'Ada Lovelace' });
    });
  });

  describe('gather:referenced-by-requested', () => {
    const TARGET = resourceId('target');
    const citing = (id: string, source: string, exact: string) => ({
      id,
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      type: 'Annotation',
      motivation: 'linking',
      target: { source, selector: [{ type: 'TextQuoteSelector', exact }] },
      body: { source: String(TARGET) },
    });

    it('lists the citers, each named from the graph or, where the graph lags, from its view', async () => {
      m.getResourceReferencedBy.mockResolvedValue([
        citing('a1', 'doc-a', 'Prometheus'),
        citing('a2', 'doc-b', 'the Titan'),
      ]);
      m.getResource.mockImplementation(async (id: string) => (id === 'doc-a' ? descriptor('doc-a', 'Prometheus Bound') : null));
      m.viewsGet.mockImplementation(async (id: string) => (id === 'doc-b' ? { resource: descriptor('doc-b', 'Theogony') } : null));

      const reply = next('gather:referenced-by-result');
      bus.emit('gather:referenced-by-requested', { resourceId: TARGET, motivation: 'linking' }, { correlationId: 'cid-2' });
      const { payload, correlationId } = await reply;

      expect(correlationId).toBe('cid-2');
      expect(m.getResourceReferencedBy).toHaveBeenCalledWith(TARGET, 'linking');
      expect(payload.response.referencedBy).toEqual([
        { id: 'a1', resourceName: 'Prometheus Bound', target: { source: 'doc-a', selector: { exact: 'Prometheus' } } },
        { id: 'a2', resourceName: 'Theogony', target: { source: 'doc-b', selector: { exact: 'the Titan' } } },
      ]);
    });

    it('a graph that fails answers on the failure channel, under the same key', async () => {
      m.getResourceReferencedBy.mockRejectedValue(new Error('neo4j is down'));

      const reply = next('gather:referenced-by-failed');
      bus.emit('gather:referenced-by-requested', { resourceId: TARGET }, { correlationId: 'cid-3' });
      const { payload, correlationId } = await reply;

      expect(correlationId).toBe('cid-3');
      expect(payload.message).toBe('neo4j is down');
    });
  });
});

// The Librarian's inbound roster and the in-process root's handler roster
// both spread RETRIEVAL_HANDLER_CHANNELS. This pins that constant to what
// the handlers subscribe: one added without the other fails here.
describe('retrieval handler roster (census gate)', () => {
  it('names exactly the channels the handlers subscribe', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const realFrames = bus.frames.bind(bus);
    bus.frames = ((channel: keyof EventMap) => {
      seen.push(channel);
      return realFrames(channel);
    }) as typeof bus.frames;

    const stateDir = await fs.mkdtemp(join(tmpdir(), 'semiont-retrieval-census-'));
    const stop = registerRetrievalHandlers(
      bus,
      readsOf(mocks()),
      { embeddingProvider: createMockEmbeddingProvider(), semanticFloor: 0.6, state: { stateDir } },
      logger,
    );
    stop();
    bus.destroy();
    await fs.rm(stateDir, { recursive: true, force: true });

    expect(new Set(seen)).toEqual(new Set(RETRIEVAL_HANDLER_CHANNELS));
  });
});
