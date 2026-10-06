/**
 * Unit tests for ResourceContext
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { ResourceContext } from '../resource-context';
import type { ResourceDescriptor, ResourceId } from '@semiont/core';
import { resourceId } from '@semiont/core';

// The slice this file exercises — DERIVED from the method's own parameter
// type, never restated.
type ResourceContextReads = Parameters<typeof ResourceContext.getResourceMetadata>[1];

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

  beforeEach(() => {
    vi.clearAllMocks();

    mockViewStorage = {
      get: vi.fn(),
    };

    mockKb = { views: mockViewStorage };
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
