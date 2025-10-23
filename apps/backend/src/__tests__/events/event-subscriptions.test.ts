/**
 * EventSubscriptions Tests - Real-time pub/sub
 *
 * Tests document-scoped and global subscriptions, fire-and-forget, and cleanup
 *
 * @see docs/EVENT-STORE.md#eventsubscriptions
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventSubscriptions } from '../../events/subscriptions/event-subscriptions';
import type { StoredEvent, DocumentEvent } from '@semiont/core';

describe('EventSubscriptions', () => {
  let subscriptions: EventSubscriptions;

  beforeEach(() => {
    subscriptions = new EventSubscriptions();
  });

  // Helper to create StoredEvent
  function createStoredEvent(type: DocumentEvent['type'], documentId?: string): StoredEvent {
    return {
      event: {
        id: 'event-1',
        type,
        userId: 'user1',
        documentId,
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {},
      },
      metadata: {
        sequenceNumber: 1,
        streamPosition: 0,
        timestamp: new Date().toISOString(),
        checksum: 'checksum1',
      },
    };
  }

  describe('Document Subscriptions', () => {
    it('should subscribe to document events', () => {
      const callback = vi.fn();
      const sub = subscriptions.subscribe('doc1', callback);

      expect(sub.documentId).toBe('doc1');
      expect(sub.callback).toBe(callback);
      expect(sub.unsubscribe).toBeTypeOf('function');
    });

    it('should notify document subscribers', async () => {
      const callback = vi.fn();
      subscriptions.subscribe('doc1', callback);

      const event = createStoredEvent('annotation.added', 'doc1');
      await subscriptions.notifySubscribers('doc1', event);

      // Fire-and-forget, so wait a tick
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callback).toHaveBeenCalledWith(event);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should support multiple subscribers for same document', async () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      subscriptions.subscribe('doc1', callback1);
      subscriptions.subscribe('doc1', callback2);
      subscriptions.subscribe('doc1', callback3);

      const event = createStoredEvent('annotation.added', 'doc1');
      await subscriptions.notifySubscribers('doc1', event);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callback1).toHaveBeenCalledWith(event);
      expect(callback2).toHaveBeenCalledWith(event);
      expect(callback3).toHaveBeenCalledWith(event);
    });

    it('should not notify subscribers of other documents', async () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      subscriptions.subscribe('doc1', callback1);
      subscriptions.subscribe('doc2', callback2);

      const event = createStoredEvent('annotation.added', 'doc1');
      await subscriptions.notifySubscribers('doc1', event);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callback1).toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
    });

    it('should unsubscribe from document events', async () => {
      const callback = vi.fn();
      const sub = subscriptions.subscribe('doc1', callback);

      sub.unsubscribe();

      const event = createStoredEvent('annotation.added', 'doc1');
      await subscriptions.notifySubscribers('doc1', event);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callback).not.toHaveBeenCalled();
    });

    it('should clean up empty subscription sets', () => {
      const sub = subscriptions.subscribe('doc1', vi.fn());

      expect(subscriptions.getSubscriptionCount('doc1')).toBe(1);

      sub.unsubscribe();

      expect(subscriptions.getSubscriptionCount('doc1')).toBe(0);
    });

    it('should get subscription count for document', () => {
      subscriptions.subscribe('doc1', vi.fn());
      subscriptions.subscribe('doc1', vi.fn());
      subscriptions.subscribe('doc2', vi.fn());

      expect(subscriptions.getSubscriptionCount('doc1')).toBe(2);
      expect(subscriptions.getSubscriptionCount('doc2')).toBe(1);
      expect(subscriptions.getSubscriptionCount('doc-nonexistent')).toBe(0);
    });

    it('should get total subscription count', () => {
      subscriptions.subscribe('doc1', vi.fn());
      subscriptions.subscribe('doc1', vi.fn());
      subscriptions.subscribe('doc2', vi.fn());

      expect(subscriptions.getTotalSubscriptions()).toBe(3);
    });
  });

  describe('Global Subscriptions', () => {
    it('should subscribe to global events', () => {
      const callback = vi.fn();
      const sub = subscriptions.subscribeGlobal(callback);

      expect(sub.documentId).toBe('__global__');
      expect(sub.callback).toBe(callback);
      expect(sub.unsubscribe).toBeTypeOf('function');
    });

    it('should notify global subscribers', async () => {
      const callback = vi.fn();
      subscriptions.subscribeGlobal(callback);

      const event = createStoredEvent('entitytype.added');
      await subscriptions.notifyGlobalSubscribers(event);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callback).toHaveBeenCalledWith(event);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should support multiple global subscribers', async () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      subscriptions.subscribeGlobal(callback1);
      subscriptions.subscribeGlobal(callback2);
      subscriptions.subscribeGlobal(callback3);

      const event = createStoredEvent('entitytype.added');
      await subscriptions.notifyGlobalSubscribers(event);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callback1).toHaveBeenCalledWith(event);
      expect(callback2).toHaveBeenCalledWith(event);
      expect(callback3).toHaveBeenCalledWith(event);
    });

    it('should unsubscribe from global events', async () => {
      const callback = vi.fn();
      const sub = subscriptions.subscribeGlobal(callback);

      sub.unsubscribe();

      const event = createStoredEvent('entitytype.added');
      await subscriptions.notifyGlobalSubscribers(event);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callback).not.toHaveBeenCalled();
    });

    it('should get global subscription count', () => {
      subscriptions.subscribeGlobal(vi.fn());
      subscriptions.subscribeGlobal(vi.fn());

      expect(subscriptions.getGlobalSubscriptionCount()).toBe(2);
    });

    it('should not affect document subscriptions', async () => {
      const docCallback = vi.fn();
      const globalCallback = vi.fn();

      subscriptions.subscribe('doc1', docCallback);
      subscriptions.subscribeGlobal(globalCallback);

      // Notify document subscribers
      const docEvent = createStoredEvent('annotation.added', 'doc1');
      await subscriptions.notifySubscribers('doc1', docEvent);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(docCallback).toHaveBeenCalled();
      expect(globalCallback).not.toHaveBeenCalled();

      docCallback.mockClear();
      globalCallback.mockClear();

      // Notify global subscribers
      const globalEvent = createStoredEvent('entitytype.added');
      await subscriptions.notifyGlobalSubscribers(globalEvent);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(docCallback).not.toHaveBeenCalled();
      expect(globalCallback).toHaveBeenCalled();
    });
  });

  describe('Fire-and-Forget Pattern', () => {
    it('should not block on slow subscribers', async () => {
      const fastCallback = vi.fn();
      const slowCallback = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
      });

      subscriptions.subscribe('doc1', fastCallback);
      subscriptions.subscribe('doc1', slowCallback);

      const event = createStoredEvent('annotation.added', 'doc1');

      const start = Date.now();
      await subscriptions.notifySubscribers('doc1', event);
      const duration = Date.now() - start;

      // notifySubscribers should return immediately (< 50ms)
      expect(duration).toBeLessThan(50);

      // But callbacks should still be called eventually
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(fastCallback).toHaveBeenCalled();
      expect(slowCallback).toHaveBeenCalled();
    });

    it('should handle errors in async callbacks without affecting others', async () => {
      const goodCallback = vi.fn();
      // Return a promise that rejects (async error handling)
      const badCallback = vi.fn(async () => {
        throw new Error('Callback error');
      });
      const anotherGoodCallback = vi.fn();

      subscriptions.subscribe('doc1', goodCallback);
      subscriptions.subscribe('doc1', badCallback);
      subscriptions.subscribe('doc1', anotherGoodCallback);

      const event = createStoredEvent('annotation.added', 'doc1');

      // Should not throw - fire-and-forget means errors are caught internally
      await subscriptions.notifySubscribers('doc1', event);

      // Wait for async callbacks to complete
      await new Promise(resolve => setTimeout(resolve, 20));

      // All callbacks should be called despite error
      expect(goodCallback).toHaveBeenCalled();
      expect(badCallback).toHaveBeenCalled();
      expect(anotherGoodCallback).toHaveBeenCalled();
    });

    it('should support async callbacks', async () => {
      const asyncCallback = vi.fn(async (event: StoredEvent) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return event.event.type;
      });

      subscriptions.subscribe('doc1', asyncCallback);

      const event = createStoredEvent('annotation.added', 'doc1');
      await subscriptions.notifySubscribers('doc1', event);

      await new Promise(resolve => setTimeout(resolve, 20));

      expect(asyncCallback).toHaveBeenCalledWith(event);
    });
  });

  describe('Edge Cases', () => {
    it('should handle notification with no subscribers', async () => {
      const event = createStoredEvent('annotation.added', 'doc-nonexistent');

      await expect(subscriptions.notifySubscribers('doc-nonexistent', event)).resolves.toBeUndefined();
    });

    it('should handle global notification with no subscribers', async () => {
      const event = createStoredEvent('entitytype.added');

      await expect(subscriptions.notifyGlobalSubscribers(event)).resolves.toBeUndefined();
    });

    it('should allow re-subscribing after unsubscribing', async () => {
      const callback = vi.fn();

      const sub1 = subscriptions.subscribe('doc1', callback);
      sub1.unsubscribe();

      const sub2 = subscriptions.subscribe('doc1', callback);

      const event = createStoredEvent('annotation.added', 'doc1');
      await subscriptions.notifySubscribers('doc1', event);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callback).toHaveBeenCalledTimes(1);

      sub2.unsubscribe();
    });

    it('should handle unsubscribe called multiple times', () => {
      const sub = subscriptions.subscribe('doc1', vi.fn());

      expect(() => {
        sub.unsubscribe();
        sub.unsubscribe();
        sub.unsubscribe();
      }).not.toThrow();
    });
  });
});
