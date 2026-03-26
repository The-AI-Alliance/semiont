/**
 * SSEClient tests
 *
 * Tests that SSEClient methods construct the correct URL, pass the correct
 * fetch options, and wire the onConnected callback. Uses a mock for
 * createSSEStream so tests stay fast and synchronous.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus, baseUrl } from '@semiont/core';
import type { SSEStream } from '../sse/types';

// Mock createSSEStream before importing SSEClient
vi.mock('../sse/stream', () => ({
  createSSEStream: vi.fn(),
}));

import { createSSEStream } from '../sse/stream';
import { SSEClient, SSE_STREAM_CONNECTED } from '../sse';

function makeMockStream(): SSEStream {
  return { close: vi.fn() };
}

describe('SSEClient', () => {
  let client: SSEClient;
  let eventBus: EventBus;
  const testBaseUrl = baseUrl('http://localhost:4000');
  const auth = 'test-token' as any;

  beforeEach(() => {
    eventBus = new EventBus();
    client = new SSEClient({ baseUrl: testBaseUrl });
    vi.mocked(createSSEStream).mockReturnValue(makeMockStream());
  });

  afterEach(() => {
    eventBus.destroy();
    vi.clearAllMocks();
  });

  // =========================================================================
  // attentionStream
  // =========================================================================

  describe('attentionStream', () => {
    test('calls createSSEStream with the correct URL', () => {
      client.attentionStream({ auth, eventBus });

      expect(createSSEStream).toHaveBeenCalledWith(
        'http://localhost:4000/api/participants/me/attention-stream',
        expect.objectContaining({ method: 'GET' }),
        expect.objectContaining({ progressEvents: ['*'], completeEvent: null, errorEvent: null }),
        undefined
      );
    });

    test('includes Authorization header when auth token provided', () => {
      client.attentionStream({ auth, eventBus });

      const [, fetchOptions] = vi.mocked(createSSEStream).mock.calls[0];
      expect(fetchOptions.headers).toMatchObject({ Authorization: `Bearer ${auth}` });
    });

    test('omits Authorization header when no auth token', () => {
      client.attentionStream({ eventBus });

      const [, fetchOptions] = vi.mocked(createSSEStream).mock.calls[0];
      expect((fetchOptions.headers as Record<string, string>)['Authorization']).toBeUndefined();
    });

    test('passes eventBus to createSSEStream', () => {
      client.attentionStream({ auth, eventBus });

      const [, , config] = vi.mocked(createSSEStream).mock.calls[0];
      expect(config.eventBus).toBe(eventBus);
    });

    test('returns the SSEStream from createSSEStream', () => {
      const mockStream = makeMockStream();
      vi.mocked(createSSEStream).mockReturnValue(mockStream);

      const result = client.attentionStream({ auth, eventBus });
      expect(result).toBe(mockStream);
    });

    test('calls onConnected callback once when stream-connected fires', () => {
      const onConnected = vi.fn();
      client.attentionStream({ auth, eventBus, onConnected });

      // Simulate the SSE infrastructure emitting stream-connected
      eventBus.get(SSE_STREAM_CONNECTED as any).next({} as any);

      expect(onConnected).toHaveBeenCalledTimes(1);
    });

    test('onConnected fires only once even if stream-connected emits again', () => {
      const onConnected = vi.fn();
      client.attentionStream({ auth, eventBus, onConnected });

      eventBus.get(SSE_STREAM_CONNECTED as any).next({} as any);
      eventBus.get(SSE_STREAM_CONNECTED as any).next({} as any);

      expect(onConnected).toHaveBeenCalledTimes(1);
    });

    test('does not subscribe to stream-connected when onConnected not provided', () => {
      // Should not throw, and stream-connected emissions should be harmless
      client.attentionStream({ auth, eventBus });
      expect(() => eventBus.get(SSE_STREAM_CONNECTED as any).next({} as any)).not.toThrow();
    });

    test('strips trailing slash from baseUrl', () => {
      const clientWithSlash = new SSEClient({ baseUrl: baseUrl('http://localhost:4000/') });
      clientWithSlash.attentionStream({ auth, eventBus });

      const [url] = vi.mocked(createSSEStream).mock.calls[0];
      expect(url).toBe('http://localhost:4000/api/participants/me/attention-stream');
    });
  });

  // =========================================================================
  // globalEvents — verify attentionStream mirrors the same pattern
  // =========================================================================

  describe('globalEvents', () => {
    test('calls createSSEStream with the global events URL', () => {
      client.globalEvents({ auth, eventBus });

      const [url] = vi.mocked(createSSEStream).mock.calls[0];
      expect(url).toBe('http://localhost:4000/api/events/stream');
    });

    test('uses wildcard progressEvents with no completeEvent', () => {
      client.globalEvents({ auth, eventBus });

      const [, , config] = vi.mocked(createSSEStream).mock.calls[0];
      expect(config.progressEvents).toEqual(['*']);
      expect(config.completeEvent).toBeNull();
      expect(config.errorEvent).toBeNull();
    });
  });
});
