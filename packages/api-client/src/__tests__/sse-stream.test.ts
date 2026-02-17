/**
 * Tests for SSE stream parsing
 *
 * Tests the createSSEStream function which handles Server-Sent Events parsing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSSEStream } from '../sse/stream';
import type { ReferenceDetectionProgress, GenerationProgress } from '../sse/types';

// Helper to create a ReadableStream from SSE text
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

describe('createSSEStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic SSE Parsing', () => {
    it('should parse simple SSE events', async () => {
      const sseText = `event: test-event
data: {"message":"hello"}

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const progressCallback = vi.fn();

      const stream = createSSEStream(
        'http://test.com/stream',
        { method: 'GET', headers: {} },
        {
          progressEvents: ['test-event'],
          completeEvent: null,
          errorEvent: null
        }
      );

      stream.onProgress(progressCallback);

      await wait(50); // Wait for stream to process

      expect(progressCallback).toHaveBeenCalledWith({ message: 'hello' });
    });

    it('should handle events without event type (default message)', async () => {
      const sseText = `data: {"value":42}

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const progressCallback = vi.fn();

      const stream = createSSEStream(
        'http://test.com/stream',
        { method: 'GET', headers: {} },
        {
          progressEvents: [''], // Empty string matches events without type
          completeEvent: null,
          errorEvent: null
        }
      );

      stream.onProgress(progressCallback);

      await wait(50);

      expect(progressCallback).toHaveBeenCalledWith({ value: 42 });
    });

    it('should parse event with id field', async () => {
      const sseText = `event: numbered-event
data: {"count":1}
id: 123

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const progressCallback = vi.fn();

      const stream = createSSEStream(
        'http://test.com/stream',
        { method: 'GET', headers: {} },
        {
          progressEvents: ['numbered-event'],
          completeEvent: null,
          errorEvent: null
        }
      );

      stream.onProgress(progressCallback);

      await wait(50);

      expect(progressCallback).toHaveBeenCalledWith({ count: 1 });
    });
  });

  describe('Detection Stream', () => {
    it('should handle detection progress events', async () => {
      const sseText = `event: reference-detection-started
data: {"status":"started","resourceId":"res-123","totalEntityTypes":2,"processedEntityTypes":0,"message":"Starting..."}

event: reference-detection-progress
data: {"status":"scanning","resourceId":"res-123","currentEntityType":"Person","totalEntityTypes":2,"processedEntityTypes":1}

event: reference-detection-complete
data: {"status":"complete","resourceId":"res-123","totalEntityTypes":2,"processedEntityTypes":2,"foundCount":5}

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const progressCallback = vi.fn<(progress: ReferenceDetectionProgress) => void>();
      const completeCallback = vi.fn<(result: ReferenceDetectionProgress) => void>();

      const stream = createSSEStream<ReferenceDetectionProgress, ReferenceDetectionProgress>(
        'http://test.com/detect',
        { method: 'POST', headers: {}, body: JSON.stringify({ entityTypes: ['Person'] }) },
        {
          progressEvents: ['reference-detection-started', 'reference-detection-progress'],
          completeEvent: 'reference-detection-complete',
          errorEvent: 'reference-detection-error'
        }
      );

      stream.onProgress(progressCallback);
      stream.onComplete(completeCallback);

      await wait(100);

      // Progress callback should be called twice (started, progress)
      expect(progressCallback).toHaveBeenCalledTimes(2);
      expect(progressCallback).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'started' }));
      expect(progressCallback).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: 'scanning', currentEntityType: 'Person' }));

      // Complete callback should be called once
      expect(completeCallback).toHaveBeenCalledTimes(1);
      expect(completeCallback).toHaveBeenCalledWith(expect.objectContaining({ status: 'complete', foundCount: 5 }));
    });

    it('should handle detection error events', async () => {
      const sseText = `event: reference-detection-error
data: {"status":"error","message":"Entity detection failed","resourceId":"res-123","totalEntityTypes":2,"processedEntityTypes":0}

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const errorCallback = vi.fn();

      const stream = createSSEStream<ReferenceDetectionProgress, ReferenceDetectionProgress>(
        'http://test.com/detect',
        { method: 'POST', headers: {} },
        {
          progressEvents: ['reference-detection-started', 'reference-detection-progress'],
          completeEvent: 'reference-detection-complete',
          errorEvent: 'reference-detection-error'
        }
      );

      stream.onError(errorCallback);

      await wait(50);

      expect(errorCallback).toHaveBeenCalledWith(expect.any(Error));
      expect(errorCallback.mock.calls[0][0].message).toBe('Entity detection failed');
    });
  });

  describe('Generation Stream', () => {
    it('should handle generation progress with percentage', async () => {
      const sseText = `event: generation-started
data: {"status":"started","referenceId":"ann-456","percentage":0,"message":"Starting..."}

event: generation-progress
data: {"status":"generating","referenceId":"ann-456","percentage":50,"message":"Generating content..."}

event: generation-complete
data: {"status":"complete","referenceId":"ann-456","resourceId":"res-789","percentage":100,"message":"Done!"}

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const progressCallback = vi.fn<(progress: GenerationProgress) => void>();
      const completeCallback = vi.fn<(result: GenerationProgress) => void>();

      const stream = createSSEStream<GenerationProgress, GenerationProgress>(
        'http://test.com/generate',
        { method: 'POST', headers: {} },
        {
          progressEvents: ['generation-started', 'generation-progress'],
          completeEvent: 'generation-complete',
          errorEvent: 'generation-error'
        }
      );

      stream.onProgress(progressCallback);
      stream.onComplete(completeCallback);

      await wait(100);

      expect(progressCallback).toHaveBeenCalledTimes(2);
      expect(progressCallback).toHaveBeenNthCalledWith(1, expect.objectContaining({ percentage: 0 }));
      expect(progressCallback).toHaveBeenNthCalledWith(2, expect.objectContaining({ percentage: 50, status: 'generating' }));

      expect(completeCallback).toHaveBeenCalledWith(expect.objectContaining({ percentage: 100, resourceId: 'res-789' }));
    });
  });

  describe('Keep-Alive Handling', () => {
    it('should skip keep-alive comments', async () => {
      const sseText = `event: test-event
data: {"count":1}

data: :keep-alive

event: test-event
data: {"count":2}

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const progressCallback = vi.fn();

      const stream = createSSEStream(
        'http://test.com/stream',
        { method: 'GET', headers: {} },
        {
          progressEvents: ['test-event'],
          completeEvent: null,
          errorEvent: null
        }
      );

      stream.onProgress(progressCallback);

      await wait(50);

      // Should only be called twice, not three times (keep-alive skipped)
      expect(progressCallback).toHaveBeenCalledTimes(2);
      expect(progressCallback).toHaveBeenNthCalledWith(1, { count: 1 });
      expect(progressCallback).toHaveBeenNthCalledWith(2, { count: 2 });
    });
  });

  describe('Buffer Edge Cases', () => {
    it('should handle partial lines in buffer', async () => {
      // Simulate chunked data arriving
      const chunks = [
        'event: test\ndata: {"part":',
        '1}\n\n'
      ];

      let chunkIndex = 0;
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const sendNext = () => {
            if (chunkIndex < chunks.length) {
              controller.enqueue(encoder.encode(chunks[chunkIndex++]));
              setTimeout(sendNext, 10);
            } else {
              controller.close();
            }
          };
          sendNext();
        }
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: stream
      });

      const progressCallback = vi.fn();

      createSSEStream(
        'http://test.com/stream',
        { method: 'GET', headers: {} },
        {
          progressEvents: ['test'],
          completeEvent: null,
          errorEvent: null
        }
      ).onProgress(progressCallback);

      await wait(100);

      expect(progressCallback).toHaveBeenCalledWith({ part: 1 });
    });
  });

  describe('Error Handling', () => {
    it('should handle HTTP errors', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ message: 'Resource not found' })
      });

      const errorCallback = vi.fn();

      const stream = createSSEStream(
        'http://test.com/stream',
        { method: 'GET', headers: {} },
        {
          progressEvents: [],
          completeEvent: null,
          errorEvent: null
        }
      );

      stream.onError(errorCallback);

      await wait(50);

      expect(errorCallback).toHaveBeenCalledWith(expect.any(Error));
      expect(errorCallback.mock.calls[0][0].message).toContain('Resource not found');
    });

    it('should handle null response body', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        body: null
      });

      const errorCallback = vi.fn();

      const stream = createSSEStream(
        'http://test.com/stream',
        { method: 'GET', headers: {} },
        {
          progressEvents: [],
          completeEvent: null,
          errorEvent: null
        }
      );

      stream.onError(errorCallback);

      await wait(50);

      expect(errorCallback).toHaveBeenCalledWith(expect.any(Error));
      expect(errorCallback.mock.calls[0][0].message).toContain('Response body is null');
    });

    it('should handle malformed JSON gracefully', async () => {
      const sseText = `event: test-event
data: {invalid-json

`;

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const progressCallback = vi.fn();

      const stream = createSSEStream(
        'http://test.com/stream',
        { method: 'GET', headers: {} },
        {
          progressEvents: ['test-event'],
          completeEvent: null,
          errorEvent: null
        }
      );

      stream.onProgress(progressCallback);

      await wait(50);

      // Should not call progress callback (JSON parse failed)
      expect(progressCallback).not.toHaveBeenCalled();

      // Should log error
      expect(consoleError).toHaveBeenCalledWith(
        '[SSE] Failed to parse event data:',
        expect.any(Error)
      );

      consoleError.mockRestore();
    });
  });

  describe('Abort/Cancellation', () => {
    it('should abort stream when close() is called', async () => {
      const sseText = `event: test-event
data: {"count":1}

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const stream = createSSEStream(
        'http://test.com/stream',
        { method: 'GET', headers: {} },
        {
          progressEvents: ['test-event'],
          completeEvent: null,
          errorEvent: null
        }
      );

      stream.close();

      // Fetch should have been called with AbortSignal
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/stream',
        expect.objectContaining({
          signal: expect.any(AbortSignal)
        })
      );
    });

    it('should not call error callback for AbortError', async () => {
      fetchMock.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

      const errorCallback = vi.fn();

      const stream = createSSEStream(
        'http://test.com/stream',
        { method: 'GET', headers: {} },
        {
          progressEvents: [],
          completeEvent: null,
          errorEvent: null
        }
      );

      stream.onError(errorCallback);
      stream.close();

      await wait(50);

      // Should not call error callback for normal abort
      expect(errorCallback).not.toHaveBeenCalled();
    });

    it('should close stream after complete event', async () => {
      const sseText = `event: complete-event
data: {"done":true}

event: should-not-see-this
data: {"oops":true}

`;

      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream(sseText)
      });

      const progressCallback = vi.fn();
      const completeCallback = vi.fn();

      const stream = createSSEStream(
        'http://test.com/stream',
        { method: 'GET', headers: {} },
        {
          progressEvents: ['should-not-see-this'],
          completeEvent: 'complete-event',
          errorEvent: null
        }
      );

      stream.onProgress(progressCallback);
      stream.onComplete(completeCallback);

      await wait(100);

      // Complete should be called
      expect(completeCallback).toHaveBeenCalledWith({ done: true });

      // Progress should NOT be called (stream closed after complete)
      expect(progressCallback).not.toHaveBeenCalled();
    });
  });

  describe('Request Configuration', () => {
    it('should include Accept: text/event-stream header', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        body: createSSEReadableStream('')
      });

      createSSEStream(
        'http://test.com/stream',
        {
          method: 'POST',
          headers: { 'Authorization': 'Bearer token' },
          body: JSON.stringify({ test: true })
        },
        {
          progressEvents: [],
          completeEvent: null,
          errorEvent: null
        }
      );

      await wait(10);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/stream',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer token'
          }),
          body: JSON.stringify({ test: true })
        })
      );
    });
  });
});
