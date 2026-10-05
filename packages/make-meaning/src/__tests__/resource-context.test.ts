/**
 * Unit tests for ResourceContext
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { ResourceContext } from '../resource-context';
import type { ResourceDescriptor, ResourceId } from '@semiont/core';
import { resourceId } from '@semiont/core';

// The union of the slices this file exercises — DERIVED from the methods'
// own parameter types, never restated.
type ResourceContextReads = Parameters<typeof ResourceContext.listResources>[1] &
  Parameters<typeof ResourceContext.addContentPreviews>[1];

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
  let mockKb: ResourceContextReads;
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
      getResource: vi.fn().mockResolvedValue(null),
      listResources: vi.fn().mockResolvedValue({ resources: [], total: 0 }),
    };

    mockKb = {
      views: mockViewStorage,
      content: mockRepStore,
      graph: mockGraph,
      vectors: { searchResources: vi.fn().mockResolvedValue([]) } as ResourceContextReads['vectors'],
    };
  });

  // Every listResources caller supplies the fallback deps (the vector store
  // and embedding provider are required). Tests not about the fallback pass an
  // inert bag; the fallback's own axioms below build theirs per-case.
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
          storageUri: 'abc123',
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

    test('a whitespace-only query is not a search', async () => {
      mockViewStorage.getAll.mockResolvedValue([asView(mockResource1), asView(mockResource2)]);

      const result = await ResourceContext.listResources({ search: '   ' }, mockKb, inertSemantic());

      // Blank input must not divert the listing onto the eventually-consistent
      // graph path, and must not match every name containing a space.
      expect(mockGraph.listResources).not.toHaveBeenCalled();
      expect(mockViewStorage.getAll).toHaveBeenCalled();
      expect(result.total).toBe(2);
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
      representations: [
        {
          mediaType: 'text/plain',
          checksum: 'abc123',
          storageUri: 'abc123',
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
        storageUri: 'abc123',
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
              storageUri: 'def456',
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
        storageUri: 'abc123',
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
        storageUri: 'abc123',
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
  // ── Semantic fallback — axioms S1–S6, S8 ─────────────────────────────────
  // Every case asserts `matchKind` because S1/S8's embed-absence halves would
  // pass vacuously on their own.
});

// The text-source dispatcher: the media type decides where text comes from.
// Binary is never toString'd; absent means absent, never ''.
describe('getResourceContent — text source dispatcher', () => {
  // This block asserts what was NOT called, so the calls of the blocks
  // above must not be counted against it.
  beforeEach(() => vi.clearAllMocks());

  type ContentReads2 = Parameters<typeof ResourceContext.getResourceContent>[1];

  const doc = (): ResourceDescriptor => ({
    '@context': 'https://schema.org',
    '@id': resourceId('res-dispatch'),
    name: 'Dispatch Target',
    format: 'text/plain',
    representations: [],
  });

  function reads(overrides: {
    getBinary?: ReturnType<typeof vi.fn>;
    ask?: ReturnType<typeof vi.fn>;
  } = {}): { kb: ContentReads2; getBinary: ReturnType<typeof vi.fn>; ask: ReturnType<typeof vi.fn> } {
    const getBinary = overrides.getBinary
      ?? vi.fn().mockResolvedValue({ data: new ArrayBuffer(4), contentType: 'text/plain' });
    const ask = overrides.ask
      ?? vi.fn().mockResolvedValue({ kind: 'not-yet' });
    return { kb: { content: { getBinary } as ContentReads2['content'], anchoredText: ask as ContentReads2['anchoredText'] }, getBinary, ask };
  }

  function primaryRep(mediaType: string) {
    (getPrimaryRepresentation as ReturnType<typeof vi.fn>).mockReturnValue({
      mediaType, storageUri: 'file://x', checksum: 'c', byteSize: 4, rel: 'original',
    });
  }

  test('pdf-text-layer media returns the derived text — bytes are never fetched or decoded', async () => {
    primaryRep('application/pdf');
    const { kb, getBinary, ask } = reads({
      ask: vi.fn().mockResolvedValue({ kind: 'extracted', method: 'pdf-text-layer', text: 'HONEST EXTRACTED TEXT', items: [] }),
    });

    const result = await ResourceContext.getResourceContent(doc(), kb);

    expect(result).toBe('HONEST EXTRACTED TEXT');
    expect(ask).toHaveBeenCalledWith('res-dispatch');
    expect(getBinary).not.toHaveBeenCalled();
    expect(decodeRepresentation).not.toHaveBeenCalled();
  });

  test('decode media decodes its bytes — the anchored ask is never consulted', async () => {
    primaryRep('text/markdown');
    (decodeRepresentation as ReturnType<typeof vi.fn>).mockReturnValue('DECODED TEXT');
    const { kb, getBinary, ask } = reads();

    const result = await ResourceContext.getResourceContent(doc(), kb);

    expect(result).toBe('DECODED TEXT');
    expect(getBinary).toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  test('binary with no derived text yet is ABSENT — undefined, never empty string', async () => {
    primaryRep('application/pdf');
    const { kb } = reads({ ask: vi.fn().mockResolvedValue({ kind: 'not-yet' }) });

    const result = await ResourceContext.getResourceContent(doc(), kb);

    expect(result).toBeUndefined();
    expect(result).not.toBe('');
  });

  test('a stored decline is terminal absence — undefined', async () => {
    primaryRep('application/pdf');
    const { kb } = reads({ ask: vi.fn().mockResolvedValue({ kind: 'declined', reason: 'encrypted' }) });

    expect(await ResourceContext.getResourceContent(doc(), kb)).toBeUndefined();
  });

  test("textSource 'none' media touches neither door", async () => {
    primaryRep('application/x-unknown-binary');
    const { kb, getBinary, ask } = reads();

    expect(await ResourceContext.getResourceContent(doc(), kb)).toBeUndefined();
    expect(getBinary).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });
});
