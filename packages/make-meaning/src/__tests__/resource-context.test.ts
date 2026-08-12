/**
 * Unit tests for ResourceContext
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { memoryAnchoredTextStore } from './helpers/anchored-text';
import { ResourceContext } from '../resource-context';
import type { ResourceDescriptor, ResourceId } from '@semiont/core';
import { resourceId } from '@semiont/core';
import type { KnowledgeBase } from '../knowledge-base';

// Mock the helpers ResourceContext reads from core. Use importOriginal so
// branded constructors (resourceId, etc.) keep their real implementations.
vi.mock('@semiont/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/core')>();
  return {
    ...actual,
    getPrimaryRepresentation: vi.fn(),
    decodeRepresentation: vi.fn(),
  };
});

import { getPrimaryRepresentation, decodeRepresentation } from '@semiont/core';
describe('ResourceContext', () => {
  let mockKb: KnowledgeBase;
  let mockViewStorage: any;
  let mockRepStore: any;
  let mockGraph: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockViewStorage = {
      get: vi.fn(),
      getAll: vi.fn(),
    };

    mockRepStore = {
      retrieve: vi.fn(),
    };

    mockGraph = {
      listResources: vi.fn().mockResolvedValue({ resources: [], total: 0 }),
    };

    mockKb = {
      eventStore: {} as any,
      views: mockViewStorage,
      content: mockRepStore,
      graph: mockGraph,
      anchoredText: memoryAnchoredTextStore(),
      vectors: { searchResources: vi.fn().mockResolvedValue([]), searchAnnotations: vi.fn().mockResolvedValue([]), searchByResource: vi.fn().mockResolvedValue([]) } as any,
      projectionsDir: '',
      weaveProgress: {} as any, smeltProgress: { settledAt: () => undefined, whenSettled: async () => 'inert' as const, dispose: () => {} },
    };
  });

  // Every listResources caller supplies the fallback deps (MANDATORY-EMBEDDING
  // P3 made the pair required). Tests not about the fallback pass an inert bag;
  // the fallback's own axioms below build theirs per-case.
  const inertSemantic = () => ({
    embeddingProvider: { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) } as any,
    semanticFloor: 0.6,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as any,
  });

  describe('getResourceMetadata', () => {
    const mockResource: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': resourceId('test-123'),
      name: 'Test Resource',
      archived: false,
      entityTypes: ['Document'],
      dateCreated: '2024-01-01T00:00:00Z',
      representations: [
        {
          mediaType: 'text/plain',
          checksum: 'abc123',
          byteSize: 100,
          rel: 'original',
        },
      ],
    };

    test('should return resource metadata when found', async () => {
      mockViewStorage.get.mockResolvedValue({
        resource: mockResource,
        annotations: {
          highlights: [],
          assessments: [],
          comments: [],
          tags: [],
          links: [],
          entityReferences: [],
        },
      });

      const result = await ResourceContext.getResourceMetadata('test-123' as ResourceId, mockKb);

      expect(result).toEqual(mockResource);
      expect(mockViewStorage.get).toHaveBeenCalledWith('test-123');
    });

    test('should return null when resource not found', async () => {
      mockViewStorage.get.mockResolvedValue(null);

      const result = await ResourceContext.getResourceMetadata('nonexistent' as ResourceId, mockKb);

      expect(result).toBeNull();
      expect(mockViewStorage.get).toHaveBeenCalledWith('nonexistent');
    });

  });

  describe('listResources', () => {
    const asView = (resource: ResourceDescriptor) => ({
      resource,
      annotations: {
        highlights: [],
        assessments: [],
        comments: [],
        tags: [],
        links: [],
        entityReferences: [],
      },
    });

    const mockResource1: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': resourceId('res-1'),
      name: 'Resource 1',
      archived: false,
      entityTypes: ['Document'],
      dateCreated: '2024-01-01T00:00:00Z',
      representations: [],
    };

    const mockResource2: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': resourceId('res-2'),
      name: 'Resource 2',
      archived: false,
      entityTypes: ['Image'],
      dateCreated: '2024-01-02T00:00:00Z',
      representations: [],
    };

    const mockResource3: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': resourceId('res-3'),
      name: 'Archived Resource',
      archived: true,
      entityTypes: ['Document'],
      dateCreated: '2024-01-03T00:00:00Z',
      representations: [],
    };

    test('should list all resources when no filters provided', async () => {
      mockViewStorage.getAll.mockResolvedValue([asView(mockResource1), asView(mockResource2)]);

      const result = await ResourceContext.listResources(undefined, mockKb, inertSemantic());

      expect(result.total).toBe(2);
      expect(result.resources).toContainEqual(mockResource1);
      expect(result.resources).toContainEqual(mockResource2);
    });

    test('should filter by archived status (false)', async () => {
      mockViewStorage.getAll.mockResolvedValue([asView(mockResource1), asView(mockResource3)]);

      const result = await ResourceContext.listResources({ archived: false }, mockKb, inertSemantic());

      expect(result.resources).toEqual([mockResource1]);
      expect(result.total).toBe(1);
    });

    test('should filter by archived status (true)', async () => {
      mockViewStorage.getAll.mockResolvedValue([asView(mockResource1), asView(mockResource3)]);

      const result = await ResourceContext.listResources({ archived: true }, mockKb, inertSemantic());

      expect(result.resources).toEqual([mockResource3]);
      expect(result.total).toBe(1);
    });

    test('view path filters by entityType and paginates, totalling every match', async () => {
      mockViewStorage.getAll.mockResolvedValue([
        asView(mockResource1), asView(mockResource2), asView(mockResource3),
      ]);

      const result = await ResourceContext.listResources(
        { entityType: 'Document', limit: 1, offset: 0 },
        mockKb,
        inertSemantic());

      // Two Documents match; the page holds one. `total` describes the match
      // set, because that is what the caller pages on.
      expect(result.total).toBe(2);
      expect(result.resources).toEqual([mockResource3]);
    });

    test('search path pushes every filter into the graph query', async () => {
      const specialDoc = { ...mockResource2, name: 'Special Document' };
      mockGraph.listResources.mockResolvedValue({ resources: [specialDoc], total: 42 });

      const result = await ResourceContext.listResources(
        { search: 'special', archived: false, entityType: 'Document', offset: 20, limit: 10 },
        mockKb,
        inertSemantic());

      // Every filter travels into the engine. Narrowing any of them in JS after
      // the fact would apply it to one page instead of the whole match set.
      expect(mockGraph.listResources).toHaveBeenCalledWith({
        search: 'special',
        archived: false,
        entityTypes: ['Document'],
        offset: 20,
        limit: 10,
      });
      expect(mockViewStorage.getAll).not.toHaveBeenCalled();
      expect(result.total).toBe(42);
      expect(result.resources).toEqual([specialDoc]);
    });

    test('a whitespace-only query is not a search', async () => {
      mockViewStorage.getAll.mockResolvedValue([asView(mockResource1), asView(mockResource2)]);

      const result = await ResourceContext.listResources({ search: '   ' }, mockKb, inertSemantic());

      // Blank input must not divert the listing onto the eventually-consistent
      // graph path, and must not match every name containing a space.
      expect(mockGraph.listResources).not.toHaveBeenCalled();
      expect(mockViewStorage.getAll).toHaveBeenCalled();
      expect(result.total).toBe(2);
    });

    test('search path returns nothing when the graph has no matches', async () => {
      mockGraph.listResources.mockResolvedValue({ resources: [], total: 0 });

      const result = await ResourceContext.listResources({ search: 'nonexistent' }, mockKb, inertSemantic());

      expect(result.resources).toEqual([]);
      expect(result.total).toBe(0);
    });

    test('should sort by creation date (newest first)', async () => {
      mockViewStorage.getAll.mockResolvedValue([
        asView(mockResource1), asView(mockResource2), asView(mockResource3),
      ]);

      const result = await ResourceContext.listResources(undefined, mockKb, inertSemantic());

      expect(result.resources.map(r => r.dateCreated)).toEqual([
        '2024-01-03T00:00:00Z',
        '2024-01-02T00:00:00Z',
        '2024-01-01T00:00:00Z',
      ]);
    });

    test('should handle resources without dateCreated', async () => {
      const resourceNoDate: ResourceDescriptor = {
        '@context': 'https://schema.org/',
        '@id': resourceId('res-no-date'),
        name: 'No Date Resource',
        archived: false,
        entityTypes: ['Document'],
        representations: [],
      };

      mockViewStorage.getAll.mockResolvedValue([asView(mockResource1), asView(resourceNoDate)]);

      const result = await ResourceContext.listResources(undefined, mockKb, inertSemantic());

      expect(result.total).toBe(2);
      // Resource with date should come first
      expect(result.resources[0]).toEqual(mockResource1);
    });
  });

  describe('addContentPreviews', () => {
    const mockResource: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': resourceId('test-123'),
      name: 'Test Resource',
      archived: false,
      entityTypes: ['Document'],
      dateCreated: '2024-01-01T00:00:00Z',
      storageUri: 'abc123',
      representations: [
        {
          mediaType: 'text/plain',
          checksum: 'abc123',
          byteSize: 100,
          rel: 'original',
        },
      ],
    };

    test('should add content previews to resources', async () => {
      const content = 'This is test content';

      vi.mocked(getPrimaryRepresentation).mockReturnValue({
        mediaType: 'text/plain',
        checksum: 'abc123',
        byteSize: 100,
        rel: 'original',
      });

      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(decodeRepresentation).mockReturnValue(content);

      const result = await ResourceContext.addContentPreviews([mockResource], mockKb);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        ...mockResource,
        content,
      });
      expect(mockRepStore.retrieve).toHaveBeenCalledWith('abc123');
      expect(decodeRepresentation).toHaveBeenCalledWith(Buffer.from(content), 'text/plain');
    });

    test('should handle multiple resources', async () => {
      const resources: ResourceDescriptor[] = [
        mockResource,
        {
          ...mockResource,
          '@id': resourceId('test-456'),
          representations: [
            {
              mediaType: 'text/plain',
              checksum: 'def456',
              byteSize: 50,
              rel: 'original',
            },
          ],
        },
      ];

      vi.mocked(getPrimaryRepresentation).mockImplementation((resource: Parameters<typeof getPrimaryRepresentation>[0]) => {
        const reps = resource?.representations;
        return Array.isArray(reps) ? reps[0] : reps;
      });

      mockRepStore.retrieve
        .mockResolvedValueOnce(Buffer.from('Content 1'))
        .mockResolvedValueOnce(Buffer.from('Content 2'));

      vi.mocked(decodeRepresentation)
        .mockReturnValueOnce('Content 1')
        .mockReturnValueOnce('Content 2');

      const result = await ResourceContext.addContentPreviews(resources, mockKb);

      expect(result).toHaveLength(2);
      expect(result[0]?.content).toBe('Content 1');
      expect(result[1]?.content).toBe('Content 2');
    });

    test('should handle resources without representations', async () => {
      const resourceWithoutReps: ResourceDescriptor = {
        ...mockResource,
        storageUri: undefined,
        representations: [],
      };

      vi.mocked(getPrimaryRepresentation).mockReturnValue(undefined);

      const result = await ResourceContext.addContentPreviews([resourceWithoutReps], mockKb);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ ...resourceWithoutReps, content: '' });
      expect(mockRepStore.retrieve).not.toHaveBeenCalled();
    });

    test('should handle resources without checksum', async () => {
      const repWithoutChecksum = {
        mediaType: 'text/plain',
        byteSize: 100,
        rel: 'original' as const,
      };

      const resourceNoChecksum: ResourceDescriptor = {
        ...mockResource,
        storageUri: undefined,
        representations: [repWithoutChecksum],
      };

      vi.mocked(getPrimaryRepresentation).mockReturnValue(repWithoutChecksum);

      const result = await ResourceContext.addContentPreviews([resourceNoChecksum], mockKb);

      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe('');
      expect(mockRepStore.retrieve).not.toHaveBeenCalled();
    });

    test('should handle retrieval errors gracefully', async () => {
      vi.mocked(getPrimaryRepresentation).mockReturnValue({
        mediaType: 'text/plain',
        checksum: 'abc123',
        byteSize: 100,
        rel: 'original',
      });

      mockRepStore.retrieve.mockRejectedValue(new Error('Content not found'));

      const result = await ResourceContext.addContentPreviews([mockResource], mockKb);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ ...mockResource, content: '' });
    });

    test('should handle empty input array', async () => {
      const result = await ResourceContext.addContentPreviews([], mockKb);

      expect(result).toEqual([]);
      expect(mockRepStore.retrieve).not.toHaveBeenCalled();
    });

    test('should truncate content to 200 characters', async () => {
      const longContent = 'a'.repeat(500);

      vi.mocked(getPrimaryRepresentation).mockReturnValue({
        mediaType: 'text/plain',
        checksum: 'abc123',
        byteSize: 500,
        rel: 'original',
      });

      mockRepStore.retrieve.mockResolvedValue(Buffer.from(longContent));
      vi.mocked(decodeRepresentation).mockReturnValue(longContent);

      const result = await ResourceContext.addContentPreviews([mockResource], mockKb);

      expect(result[0]?.content).toHaveLength(200);
      expect(result[0]?.content).toBe(longContent.slice(0, 200));
    });

  });
  // ── SEMANTIC-FALLBACK P2 — axioms S1–S6, S8 ──────────────────────────────
  // The ledger in .plans/SEMANTIC-FALLBACK.md is the source of truth. These
  // landed as test.fails (all seven observed red — `matchKind` did not exist
  // on ResourceContext's result) and flipped to test() with the fallback in
  // the same change. Every case asserts `matchKind` because S1/S8's
  // embed-absence halves would pass vacuously on their own — the plan's own
  // caveat.
  describe('semantic fallback — axioms (SEMANTIC-FALLBACK P2)', () => {
    const FLOOR = 0.6;
    const doc = (id: string, name = id): ResourceDescriptor => ({
      '@context': 'https://schema.org/',
      '@id': resourceId(id),
      name,
      representations: [],
    });
    const hit = (rid: string, score: number, text: string) => ({
      id: `${rid}#0`, score, resourceId: resourceId(rid), text,
    });

    let embed: ReturnType<typeof vi.fn>;
    let searchResources: ReturnType<typeof vi.fn>;
    let warn: ReturnType<typeof vi.fn>;

    const semantic = (over?: { floor?: number }) => ({
      embeddingProvider: { embed } as any,
      semanticFloor: over?.floor ?? FLOOR,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() } as any,
    });

    beforeEach(() => {
      embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
      warn = vi.fn();
      searchResources = vi.fn().mockResolvedValue([]);
      (mockKb as any).vectors = { searchResources };
      mockGraph.getResource = vi.fn().mockImplementation(async (rid: ResourceId) => doc(String(rid)));
    });

    test('S1: a non-empty lexical result never calls the embedding provider', async () => {
      mockGraph.listResources.mockResolvedValue({ resources: [doc('res-hit')], total: 1 });

      const result = await ResourceContext.listResources({ search: 'ouranos' }, mockKb, semantic());

      expect(result.matchKind).toBe('lexical');
      expect(result.total).toBe(1);
      expect(embed).not.toHaveBeenCalled();
    });

    test('S2: empty lexical + configured vectors answer semantically, labelled', async () => {
      mockGraph.listResources.mockResolvedValue({ resources: [], total: 0 });
      searchResources.mockResolvedValue([hit('res-a', 0.91, 'the passage that matched')]);

      const result = await ResourceContext.listResources({ search: 'ouranos' }, mockKb, semantic());

      expect(result.matchKind).toBe('semantic');
      expect(embed).toHaveBeenCalledTimes(1);
      expect(result.total).toBe(1);
      expect(result.resources[0]?.['@id']).toBe('res-a');
      // The snippet is the passage that matched, not the first 200 chars.
      expect((result.resources[0] as { content?: string }).content).toBe('the passage that matched');
    });

    // S3/S4 (vectors unconfigured / provider absent → empty lexical, labelled
    // lexical) retired 2026-08-12: MANDATORY-EMBEDDING P3 made the pair
    // required at the type level, so their premise is unrepresentable.
    // Reciprocal entries live in both plans' ledgers. S5 survives — mandatory
    // is not the same as always up.

    test('S5: a throwing embed degrades to the empty lexical result, logged — never an error', async () => {
      mockGraph.listResources.mockResolvedValue({ resources: [], total: 0 });
      embed.mockRejectedValue(new Error('provider down'));

      const result = await ResourceContext.listResources({ search: 'ouranos' }, mockKb, semantic());

      expect(result.matchKind).toBe('lexical');
      expect(result.total).toBe(0);
      expect(warn).toHaveBeenCalled();
    });

    test('S6: semantic results keep score order, not recency order', async () => {
      mockGraph.listResources.mockResolvedValue({ resources: [], total: 0 });
      // Recency (dateModified) would order c, b, a; scores order a, b, c.
      searchResources.mockResolvedValue([
        hit('res-b', 0.8, 'b'), hit('res-a', 0.9, 'a'), hit('res-c', 0.7, 'c'),
      ]);
      mockGraph.getResource = vi.fn().mockImplementation(async (rid: ResourceId) => ({
        ...doc(String(rid)),
        dateModified: { 'res-a': '2026-01-01', 'res-b': '2026-02-01', 'res-c': '2026-03-01' }[String(rid)],
      }));

      const result = await ResourceContext.listResources({ search: 'ouranos' }, mockKb, semantic());

      expect(result.matchKind).toBe('semantic');
      expect(result.resources.map((r) => r['@id'])).toEqual(['res-a', 'res-b', 'res-c']);
    });

    test('S8: offset > 0 never triggers the fallback', async () => {
      mockGraph.listResources.mockResolvedValue({ resources: [], total: 0 });
      searchResources.mockResolvedValue([hit('res-a', 0.9, 'a')]);

      const result = await ResourceContext.listResources({ search: 'ouranos', offset: 50 }, mockKb, semantic());

      expect(result.matchKind).toBe('lexical');
      expect(result.total).toBe(0);
      expect(embed).not.toHaveBeenCalled();
    });
  });
});
