/**
 * Searching resources by text: the lexical query in the graph, and the
 * semantic fallback's axioms. The Librarian answers this
 * (`match:resources-requested`); its handler is tested at the bus in
 * handlers/resource-retrieval.test.ts.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { resourceId, type ResourceDescriptor, type ResourceId } from '@semiont/core';
import { searchResources, withContentPreviews, type ResourceSearchReads } from '../resource-search';

const doc = (id: string, name = id): ResourceDescriptor => ({
  '@context': 'https://schema.org/',
  '@id': resourceId(id),
  name,
  representations: [],
});

describe('searchResources', () => {
  const FLOOR = 0.6;
  const hit = (rid: string, score: number, text: string) => ({
    id: `${rid}#0`, score, resourceId: resourceId(rid), text,
  });

  let listResources: ReturnType<typeof vi.fn>;
  let getResource: ReturnType<typeof vi.fn>;
  let vectorSearch: ReturnType<typeof vi.fn>;
  let embed: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;
  let kb: ResourceSearchReads;

  const semantic = (over?: { floor?: number }) => ({
    embeddingProvider: { embed } as any,
    semanticFloor: over?.floor ?? FLOOR,
    logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() } as any,
  });

  beforeEach(() => {
    listResources = vi.fn().mockResolvedValue({ resources: [], total: 0 });
    getResource = vi.fn().mockImplementation(async (rid: ResourceId) => doc(String(rid)));
    vectorSearch = vi.fn().mockResolvedValue([]);
    embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    warn = vi.fn();
    kb = {
      graph: { listResources, getResource } as ResourceSearchReads['graph'],
      views: { get: vi.fn().mockResolvedValue(null) } as ResourceSearchReads['views'],
      vectors: { searchResources: vectorSearch } as ResourceSearchReads['vectors'],
    };
  });

  test('pushes every filter into the graph query', async () => {
    const specialDoc = doc('res-2', 'Special Document');
    listResources.mockResolvedValue({ resources: [specialDoc], total: 42 });

    const result = await searchResources(
      { search: 'special', archived: false, entityType: 'Document', offset: 20, limit: 10 },
      kb,
      semantic());

    // Every filter travels into the engine. Narrowing any of them in JS after
    // the fact would apply it to one page instead of the whole match set.
    expect(listResources).toHaveBeenCalledWith({
      search: 'special',
      archived: false,
      entityTypes: ['Document'],
      offset: 20,
      limit: 10,
    });
    expect(result.total).toBe(42);
    expect(result.resources).toEqual([specialDoc]);
  });

  test('blank text matches nothing and asks no store', async () => {
    const result = await searchResources({ search: '   ' }, kb, semantic());

    // Blank input must not match every name containing a space.
    expect(result).toEqual({ resources: [], total: 0, matchKind: 'lexical' });
    expect(listResources).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  describe('semantic fallback — axioms', () => {
    test('S1: a non-empty lexical result never calls the embedding provider', async () => {
      listResources.mockResolvedValue({ resources: [doc('res-hit')], total: 1 });

      const result = await searchResources({ search: 'ouranos' }, kb, semantic());

      expect(result.matchKind).toBe('lexical');
      expect(result.total).toBe(1);
      expect(embed).not.toHaveBeenCalled();
    });

    test('S2: empty lexical + configured vectors answer semantically, labelled', async () => {
      vectorSearch.mockResolvedValue([hit('res-a', 0.91, 'the passage that matched')]);

      const result = await searchResources({ search: 'ouranos' }, kb, semantic());

      expect(result.matchKind).toBe('semantic');
      expect(embed).toHaveBeenCalledTimes(1);
      expect(result.total).toBe(1);
      expect(result.resources[0]?.['@id']).toBe('res-a');
      // The snippet is the passage that matched, not the first 200 chars.
      expect(result.resources[0]?.content).toBe('the passage that matched');
    });

    // No S3/S4 (vectors unconfigured / provider absent → empty lexical,
    // labelled lexical): the vector store and embedding provider are required
    // at the type level, so their premise is unrepresentable. S5 stands —
    // mandatory is not the same as always up.

    test('S5: a throwing embed degrades to the empty lexical result, logged — never an error', async () => {
      embed.mockRejectedValue(new Error('provider down'));

      const result = await searchResources({ search: 'ouranos' }, kb, semantic());

      expect(result.matchKind).toBe('lexical');
      expect(result.total).toBe(0);
      expect(warn).toHaveBeenCalled();
    });

    test('S6: semantic results keep score order, not recency order', async () => {
      // Recency (dateModified) would order c, b, a; scores order a, b, c.
      vectorSearch.mockResolvedValue([
        hit('res-b', 0.8, 'b'), hit('res-a', 0.9, 'a'), hit('res-c', 0.7, 'c'),
      ]);
      getResource.mockImplementation(async (rid: ResourceId) => ({
        ...doc(String(rid)),
        dateModified: { 'res-a': '2026-01-01', 'res-b': '2026-02-01', 'res-c': '2026-03-01' }[String(rid)],
      }));

      const result = await searchResources({ search: 'ouranos' }, kb, semantic());

      expect(result.matchKind).toBe('semantic');
      expect(result.resources.map((r) => r['@id'])).toEqual(['res-a', 'res-b', 'res-c']);
    });

    test('a hit below the floor is not an answer', async () => {
      vectorSearch.mockResolvedValue([hit('res-a', 0.9, 'a'), hit('res-b', 0.59, 'b')]);

      const result = await searchResources({ search: 'ouranos' }, kb, semantic());

      expect(result.total).toBe(1);
      expect(result.resources.map((r) => r['@id'])).toEqual(['res-a']);
    });

    test('S8: offset > 0 never triggers the fallback', async () => {
      vectorSearch.mockResolvedValue([hit('res-a', 0.9, 'a')]);

      const result = await searchResources({ search: 'ouranos', offset: 50 }, kb, semantic());

      expect(result.matchKind).toBe('lexical');
      expect(result.total).toBe(0);
      expect(embed).not.toHaveBeenCalled();
    });
  });
});

describe('withContentPreviews', () => {
  const stored = (id: string, mediaType: string): ResourceDescriptor => ({
    ...doc(id),
    representations: [{ mediaType, storageUri: `file://${id}`, checksum: `sum-${id}`, byteSize: 1, rel: 'original' }],
  });
  const served = (text: string, contentType = 'text/plain') => {
    const buf = Buffer.from(text, 'utf8');
    const data = new ArrayBuffer(buf.byteLength);
    new Uint8Array(data).set(buf);
    return { data, contentType };
  };

  test('cuts each preview at 200 characters, one read per resource, by its id', async () => {
    const getBinary = vi.fn().mockResolvedValue(served('x'.repeat(500)));

    const result = await withContentPreviews([stored('a', 'text/plain'), stored('b', 'text/markdown')], { getBinary });

    expect(result.map((r) => r.content.length)).toEqual([200, 200]);
    expect(getBinary.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  });

  test('a resource with no representation previews as empty, and no bytes are read', async () => {
    const getBinary = vi.fn();

    const result = await withContentPreviews([doc('bare')], { getBinary });

    expect(result[0]?.content).toBe('');
    expect(getBinary).not.toHaveBeenCalled();
  });

  test('media whose text is derived, or that has none, previews as empty with no read', async () => {
    const getBinary = vi.fn();

    const result = await withContentPreviews([stored('p', 'application/pdf'), stored('i', 'image/png')], { getBinary });

    expect(result.map((r) => r.content)).toEqual(['', '']);
    expect(getBinary).not.toHaveBeenCalled();
  });

  test('a read that fails previews as empty and spares the others', async () => {
    const getBinary = vi.fn()
      .mockRejectedValueOnce(new Error('archivist unreachable'))
      .mockResolvedValueOnce(served('still here'));

    const result = await withContentPreviews([stored('a', 'text/plain'), stored('b', 'text/plain')], { getBinary });

    expect(result.map((r) => r.content)).toEqual(['', 'still here']);
  });
});
