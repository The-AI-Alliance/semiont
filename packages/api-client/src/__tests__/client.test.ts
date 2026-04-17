import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { KyInstance } from 'ky';

vi.mock('ky', () => ({
  default: {
    create: vi.fn(),
  },
}));

import ky from 'ky';
import { SemiontApiClient } from '../client';
import type { ContentFormat } from '@semiont/core';
import { baseUrl, resourceId, EventBus } from '@semiont/core';

describe('SemiontApiClient', () => {
  let client: SemiontApiClient;
  let mockKy: KyInstance;
  const testBaseUrl = baseUrl('http://localhost:4000');
  const testResourceId = resourceId('test-resource-id');
  const testResourceUrl = `${testBaseUrl}/resources/${testResourceId}`;

  beforeEach(() => {
    mockKy = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as any;

    vi.mocked(ky.create).mockReturnValue(mockKy);

    client = new SemiontApiClient({
      baseUrl: testBaseUrl,
      eventBus: new EventBus(),
      timeout: 10000,
    });
  });

  describe('updateResource - archive operations', () => {
    test('should archive a resource', async () => {
      vi.mocked(mockKy.patch).mockReturnValue({
        text: vi.fn().mockResolvedValue(''),
      } as any);

      await client.updateResource(testResourceId, { archived: true });

      expect(mockKy.patch).toHaveBeenCalledWith(
        testResourceUrl,
        expect.objectContaining({ json: { archived: true } })
      );
    });

    test('should unarchive a resource', async () => {
      vi.mocked(mockKy.patch).mockReturnValue({
        text: vi.fn().mockResolvedValue(''),
      } as any);

      await client.updateResource(testResourceId, { archived: false });

      expect(mockKy.patch).toHaveBeenCalledWith(
        testResourceUrl,
        expect.objectContaining({ json: { archived: false } })
      );
    });
  });

  describe('User Operations', () => {
    test('should logout user', async () => {
      vi.mocked(mockKy.post).mockReturnValue({
        json: vi.fn().mockResolvedValue({ message: 'Logged out successfully' }),
      } as any);

      const result = await client.logout();

      expect(result.message).toBe('Logged out successfully');
      expect(mockKy.post).toHaveBeenCalledWith(`${testBaseUrl}/api/users/logout`, { headers: {} });
    });
  });

  describe('System Status', () => {
    test('should get system status', async () => {
      const mockResponse = {
        status: 'healthy',
        version: '1.0.0',
        features: { semanticContent: 'enabled', collaboration: 'enabled', rbac: 'disabled' },
      };

      vi.mocked(mockKy.get).mockReturnValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      } as any);

      const result = await client.getStatus();

      expect(result.version).toBe('1.0.0');
      expect(mockKy.get).toHaveBeenCalledWith(`${testBaseUrl}/api/status`, { headers: {} });
    });
  });

  describe('W3C Content Negotiation', () => {
    test('should get resource representation with default accept header', async () => {
      const mockText = '# Hello World\n\nThis is markdown content.';
      const mockBuffer = new TextEncoder().encode(mockText).buffer;

      vi.mocked(mockKy.get).mockReturnValue({
        headers: { get: vi.fn((header: string) => header === 'content-type' ? 'text/plain' : null) },
        arrayBuffer: vi.fn().mockResolvedValue(mockBuffer),
      } as any);

      const result = await client.getResourceRepresentation(testResourceId);

      expect(result.data).toBeInstanceOf(ArrayBuffer);
      expect(result.contentType).toBe('text/plain');
      expect(new TextDecoder().decode(result.data)).toBe(mockText);
    });

    test('should get resource representation with custom accept header', async () => {
      const mockMarkdown = '# Title\n\n## Section\n\nContent here.';
      const mockBuffer = new TextEncoder().encode(mockMarkdown).buffer;

      vi.mocked(mockKy.get).mockReturnValue({
        headers: { get: vi.fn((header: string) => header === 'content-type' ? 'text/markdown' : null) },
        arrayBuffer: vi.fn().mockResolvedValue(mockBuffer),
      } as any);

      const result = await client.getResourceRepresentation(testResourceId, { accept: 'text/markdown' });

      expect(result.contentType).toBe('text/markdown');
    });
  });

  describe('Streaming Content Negotiation', () => {
    test('should get resource representation as stream', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4, 5]);
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(mockData);
          controller.close();
        }
      });

      vi.mocked(mockKy.get).mockReturnValue({
        headers: { get: vi.fn((header: string) => header === 'content-type' ? 'video/mp4' : null) },
        body: mockStream,
      } as any);

      const result = await client.getResourceRepresentationStream(testResourceId, {
        accept: 'video/mp4' as ContentFormat,
      });

      expect(result.stream).toBeInstanceOf(ReadableStream);
      expect(result.contentType).toBe('video/mp4');

      const reader = result.stream.getReader();
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      expect(value).toEqual(mockData);
    });

    test('should throw error if response body is null', async () => {
      vi.mocked(mockKy.get).mockReturnValue({
        headers: { get: vi.fn(() => 'text/plain') },
        body: null,
      } as any);

      await expect(
        client.getResourceRepresentationStream(testResourceId)
      ).rejects.toThrow('Response body is null - cannot create stream');
    });
  });

  describe('dispose()', () => {
    test('should clean up actor on dispose', () => {
      client.dispose();
    });
  });
});
