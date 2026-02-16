/**
 * Tests for SSEClient
 *
 * Tests the SSEClient class which provides typed SSE streaming methods.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSEClient } from '../sse';
import type { DetectionProgress, GenerationProgress } from '../sse/types';
import type { ResourceUri, AnnotationUri } from '../branded-types';
import { baseUrl, accessToken, entityType } from '../branded-types';

// Helper to create a minimal SSE ReadableStream
function createSSEReadableStream(sseText: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(sseText);

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    }
  });
}

// Helper to wait for async callbacks
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to create branded URI types for tests
const testResourceUri = (id: string): ResourceUri => `http://localhost:4000/resources/${id}` as ResourceUri;
const testAnnotationUri = (id: string): AnnotationUri => `http://localhost:4000/annotations/${id}` as AnnotationUri;

// Mock GenerationContext for tests
const mockGenerationContext = {
  sourceContext: {
    before: 'Text before',
    selected: 'selected text',
    after: 'text after'
  },
  metadata: {
    resourceType: 'document',
    language: 'en',
    entityTypes: ['test']
  }
};

describe('SSEClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Configuration', () => {
    it('should initialize with baseUrl', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      expect(client).toBeDefined();
    });

    it('should remove trailing slash from baseUrl', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000/')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      client.detectAnnotations(testResourceUri('doc-123'), { entityTypes: [entityType('Person')] });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:4000/resources/doc-123/detect-annotations-stream',
        expect.any(Object)
      );
    });

    it('should accept auth token in request options', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      client.detectAnnotations(
        testResourceUri('doc-123'),
        { entityTypes: [entityType('Person')] },
        { auth: accessToken('test-token') }
      );

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token'
          })
        })
      );
    });

    it('should support different auth tokens per request', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      client.detectAnnotations(
        testResourceUri('doc-123'),
        { entityTypes: [entityType('Person')] },
        { auth: accessToken('first-token') }
      );

      client.detectAnnotations(
        testResourceUri('doc-456'),
        { entityTypes: [entityType('Person')] },
        { auth: accessToken('second-token') }
      );

      expect(fetchMock).toHaveBeenNthCalledWith(1,
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer first-token'
          })
        })
      );

      expect(fetchMock).toHaveBeenNthCalledWith(2,
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer second-token'
          })
        })
      );
    });

    it('should work without auth token', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      client.detectAnnotations(testResourceUri('doc-123'), { entityTypes: [entityType('Person')] });

      const callHeaders = fetchMock.mock.calls[0][1].headers;
      expect(callHeaders['Authorization']).toBeUndefined();
    });
  });

  describe('detectAnnotations()', () => {
    it('should construct correct URL from resource ID', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      client.detectAnnotations(testResourceUri('doc-123'), { entityTypes: [entityType('Person')] });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:4000/resources/doc-123/detect-annotations-stream',
        expect.any(Object)
      );
    });

    it('should extract ID from full URI', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      client.detectAnnotations(testResourceUri('doc-123'), { entityTypes: [entityType('Person')] });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:4000/resources/doc-123/detect-annotations-stream',
        expect.any(Object)
      );
    });

    it('should send correct request body', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      client.detectAnnotations(testResourceUri('doc-123'), { entityTypes: [entityType('Person'), entityType('Organization')] });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ entityTypes: [entityType('Person'), entityType('Organization')] })
        })
      );
    });

    it('should stream detection progress events', async () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      const sseText = `event: detection-started
data: {"status":"started","resourceId":"doc-123","totalEntityTypes":1,"processedEntityTypes":0}

event: detection-progress
data: {"status":"scanning","resourceId":"doc-123","currentEntityType":"Person","totalEntityTypes":1,"processedEntityTypes":0}

event: detection-complete
data: {"status":"complete","resourceId":"doc-123","totalEntityTypes":1,"processedEntityTypes":1,"foundCount":5}

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const progressCallback = vi.fn<(progress: DetectionProgress) => void>();
      const completeCallback = vi.fn<(result: DetectionProgress) => void>();

      const stream = client.detectAnnotations(testResourceUri('doc-123'), { entityTypes: [entityType('Person')] });

      stream.onProgress(progressCallback);
      stream.onComplete(completeCallback);

      await wait(100);

      expect(progressCallback).toHaveBeenCalledTimes(2);
      expect(progressCallback).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'started' }));
      expect(progressCallback).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: 'scanning', currentEntityType: 'Person' }));

      expect(completeCallback).toHaveBeenCalledTimes(1);
      expect(completeCallback).toHaveBeenCalledWith(expect.objectContaining({ status: 'complete', foundCount: 5 }));
    });

    it('should handle detection errors', async () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      const sseText = `event: detection-error
data: {"status":"error","message":"Detection failed","resourceId":"doc-123","totalEntityTypes":1,"processedEntityTypes":0}

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const errorCallback = vi.fn();

      const stream = client.detectAnnotations(testResourceUri('doc-123'), { entityTypes: [entityType('Person')] });

      stream.onError(errorCallback);

      await wait(50);

      expect(errorCallback).toHaveBeenCalledWith(expect.any(Error));
      expect(errorCallback.mock.calls[0][0].message).toBe('Detection failed');
    });
  });

  describe('generateResourceFromAnnotation()', () => {
    it('should construct correct URL from resource and annotation IDs', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      client.generateResourceFromAnnotation(testResourceUri('doc-123'), testAnnotationUri('ann-456'), { context: mockGenerationContext });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:4000/resources/doc-123/annotations/ann-456/generate-resource-stream',
        expect.any(Object)
      );
    });

    it('should extract IDs from full URIs', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      client.generateResourceFromAnnotation(
        testResourceUri('doc-123'),
        testAnnotationUri('ann-456'),
        { context: mockGenerationContext }
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:4000/resources/doc-123/annotations/ann-456/generate-resource-stream',
        expect.any(Object)
      );
    });

    it('should send correct request body with options', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      client.generateResourceFromAnnotation(testResourceUri('doc-123'), testAnnotationUri('ann-456'), {
        title: 'Custom Title',
        language: 'es',
        prompt: 'Custom prompt',
        context: mockGenerationContext
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            title: 'Custom Title',
            language: 'es',
            prompt: 'Custom prompt',
            context: mockGenerationContext
          })
        })
      );
    });

    it('should require context in request body', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      client.generateResourceFromAnnotation(testResourceUri('doc-123'), testAnnotationUri('ann-456'), { context: mockGenerationContext });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"sourceContext"')
        })
      );
    });

    it('should stream generation progress events', async () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      const sseText = `event: generation-started
data: {"status":"started","referenceId":"ann-456","percentage":0,"message":"Starting..."}

event: generation-progress
data: {"status":"generating","referenceId":"ann-456","percentage":50,"message":"Generating content..."}

event: generation-complete
data: {"status":"complete","referenceId":"ann-456","resourceId":"doc-789","percentage":100,"message":"Done!"}

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const progressCallback = vi.fn<(progress: GenerationProgress) => void>();
      const completeCallback = vi.fn<(result: GenerationProgress) => void>();

      const stream = client.generateResourceFromAnnotation(testResourceUri('doc-123'), testAnnotationUri('ann-456'), { context: mockGenerationContext });

      stream.onProgress(progressCallback);
      stream.onComplete(completeCallback);

      await wait(100);

      expect(progressCallback).toHaveBeenCalledTimes(2);
      expect(progressCallback).toHaveBeenNthCalledWith(1, expect.objectContaining({ percentage: 0 }));
      expect(progressCallback).toHaveBeenNthCalledWith(2, expect.objectContaining({ percentage: 50, status: 'generating' }));

      expect(completeCallback).toHaveBeenCalledTimes(1);
      expect(completeCallback).toHaveBeenCalledWith(expect.objectContaining({ percentage: 100, resourceId: 'doc-789' }));
    });
  });

  describe('resourceEvents()', () => {
    it('should construct correct URL from resource ID', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      client.resourceEvents(testResourceUri('doc-123'));

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:4000/resources/doc-123/events/stream',
        expect.any(Object)
      );
    });

    it('should use GET method', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      client.resourceEvents(testResourceUri('doc-123'));

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'GET'
        })
      );
    });

    it('should stream resource events', async () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      const sseText = `event: resource.created
data: {"id":"evt-1","type":"resource.created","timestamp":"2025-01-01T00:00:00Z","userId":"user-1","resourceId":"doc-123","payload":{"title":"Test"},"metadata":{"sequenceNumber":1,"prevEventHash":"","checksum":"abc123"}}

event: annotation.added
data: {"id":"evt-2","type":"annotation.added","timestamp":"2025-01-01T00:01:00Z","userId":"user-2","resourceId":"doc-123","payload":{"annotationId":"ann-1"},"metadata":{"sequenceNumber":2,"prevEventHash":"abc123","checksum":"def456"}}

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const eventCallback = vi.fn<(event: any) => void>();

      const stream = client.resourceEvents(testResourceUri('doc-123'));

      stream.onProgress(eventCallback);

      await wait(100);

      expect(eventCallback).toHaveBeenCalledTimes(2);
      expect(eventCallback).toHaveBeenNthCalledWith(1, expect.objectContaining({
        type: 'resource.created',
        userId: 'user-1',
        metadata: expect.objectContaining({ sequenceNumber: 1 })
      }));
      expect(eventCallback).toHaveBeenNthCalledWith(2, expect.objectContaining({
        type: 'annotation.added',
        userId: 'user-2',
        metadata: expect.objectContaining({ sequenceNumber: 2 })
      }));
    });

    it('should not have a complete event (long-lived stream)', async () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      // Stream with many events - should keep processing until explicitly closed
      const sseText = `event: resource.created
data: {"id":"evt-1","type":"resource.created","timestamp":"2025-01-01T00:00:00Z","userId":"user-1","resourceId":"doc-123","payload":{},"metadata":{"sequenceNumber":1,"prevEventHash":"","checksum":"abc"}}

event: annotation.added
data: {"id":"evt-2","type":"annotation.added","timestamp":"2025-01-01T00:01:00Z","userId":"user-1","resourceId":"doc-123","payload":{},"metadata":{"sequenceNumber":2,"prevEventHash":"abc","checksum":"def"}}

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const eventCallback = vi.fn<(event: any) => void>();
      const completeCallback = vi.fn();

      const stream = client.resourceEvents(testResourceUri('doc-123'));

      stream.onProgress(eventCallback);
      stream.onComplete(completeCallback);

      await wait(100);

      // Events should be received
      expect(eventCallback).toHaveBeenCalledTimes(2);

      // Complete should NEVER be called (long-lived stream)
      expect(completeCallback).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle HTTP errors', async () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ message: 'Resource not found' })
      });

      const errorCallback = vi.fn();

      const stream = client.detectAnnotations(testResourceUri('doc-123'), { entityTypes: [entityType('Person')] });

      stream.onError(errorCallback);

      await wait(50);

      expect(errorCallback).toHaveBeenCalledWith(expect.any(Error));
      expect(errorCallback.mock.calls[0][0].message).toContain('Resource not found');
    });

    it('should handle network errors', async () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockRejectedValue(new Error('Network error'));

      const errorCallback = vi.fn();

      const stream = client.detectAnnotations(testResourceUri('doc-123'), { entityTypes: [entityType('Person')] });

      stream.onError(errorCallback);

      await wait(50);

      expect(errorCallback).toHaveBeenCalledWith(expect.any(Error));
      expect(errorCallback.mock.calls[0][0].message).toBe('Network error');
    });
  });

  describe('Stream Lifecycle', () => {
    it('should support closing the stream', () => {
      const client = new SSEClient({
        baseUrl: baseUrl('http://localhost:4000')
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      const stream = client.detectAnnotations(testResourceUri('doc-123'), { entityTypes: [entityType('Person')] });

      expect(() => stream.close()).not.toThrow();
    });
  });
});
