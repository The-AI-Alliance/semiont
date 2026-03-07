/**
 * EventBus Tests
 * Tests for event pub/sub wrapper layer
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../event-bus';
import { resourceId, userId } from '@semiont/core';
import type { StoredEvent, EventMetadata } from '@semiont/core';

// Helper to create minimal EventMetadata for tests
function createEventMetadata(sequenceNumber: number, prevHash?: string): EventMetadata {
  return {
    sequenceNumber,
    streamPosition: sequenceNumber * 100, // Fake stream position
    timestamp: new Date().toISOString(),
    prevEventHash: prevHash,
  };
}

describe('EventBus', () => {
  let bus: EventBus;
  const identifierConfig = { baseUrl: 'http://localhost:4000' };

  beforeEach(() => {
    bus = new EventBus({ identifierConfig });
    // Clear all subscriptions before each test
    (bus.subscriptions as any).subscriptions.clear();
    (bus.subscriptions as any).globalSubscriptions.clear();
  });

  describe('Constructor', () => {
    it('should create EventBus with identifier config', () => {
      expect(bus).toBeDefined();
      expect(bus.subscriptions).toBeDefined();
    });

    it('should use singleton subscriptions', () => {
      const bus2 = new EventBus({ identifierConfig });
      expect(bus.subscriptions).toBe(bus2.subscriptions);
    });
  });

  describe('publish()', () => {
    it('should publish resource events to resource subscribers', async () => {
      const rid = resourceId('doc1');
      const callback = vi.fn();

      bus.subscribe(rid, callback);

      const event: StoredEvent = {
        event: {
          id: 'event1',
          type: 'resource.created',
          timestamp: new Date().toISOString(),
          userId: userId('user1'),
          resourceId: rid,
          version: 1,
          payload: {
            name: 'Test',
            format: 'text/plain' as const,
            contentChecksum: 'checksum1',
            creationMethod: 'api' as const,
          },
        },
        metadata: createEventMetadata(1),
      };

      await bus.publish(event);

      expect(callback).toHaveBeenCalledWith(event);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should publish system events to global subscribers', async () => {
      const callback = vi.fn();

      bus.subscribeGlobal(callback);

      const event: StoredEvent = {
        event: {
          id: 'event1',
          type: 'entitytype.added',
          timestamp: new Date().toISOString(),
          userId: userId('system'),
          version: 1,
          payload: {
            entityType: 'Document',
          },
        },
        metadata: createEventMetadata(1),
      };

      await bus.publish(event);

      expect(callback).toHaveBeenCalledWith(event);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should not notify resource subscribers for system events', async () => {
      const rid = resourceId('doc1');
      const resourceCallback = vi.fn();
      const globalCallback = vi.fn();

      bus.subscribe(rid, resourceCallback);
      bus.subscribeGlobal(globalCallback);

      const systemEvent: StoredEvent = {
        event: {
          id: 'event1',
          type: 'entitytype.added',
          timestamp: new Date().toISOString(),
          userId: userId('system'),
          version: 1,
          payload: { entityType: 'Document' },
        },
        metadata: createEventMetadata(1),
      };

      await bus.publish(systemEvent);

      expect(resourceCallback).not.toHaveBeenCalled();
      expect(globalCallback).toHaveBeenCalledTimes(1);
    });

    it('should publish resource events to BOTH resource-scoped AND global subscribers', async () => {
      const rid = resourceId('doc1');
      const resourceCallback = vi.fn();
      const globalCallback = vi.fn();

      bus.subscribe(rid, resourceCallback);
      bus.subscribeGlobal(globalCallback);

      const resourceEvent: StoredEvent = {
        event: {
          id: 'event1',
          type: 'resource.created',
          timestamp: new Date().toISOString(),
          userId: userId('user1'),
          resourceId: rid,
          version: 1,
          payload: {
            name: 'Test Resource',
            format: 'text/plain' as const,
            contentChecksum: 'checksum1',
            creationMethod: 'api' as const,
          },
        },
        metadata: createEventMetadata(1),
      };

      await bus.publish(resourceEvent);

      // Both callbacks should receive the event
      expect(resourceCallback).toHaveBeenCalledWith(resourceEvent);
      expect(resourceCallback).toHaveBeenCalledTimes(1);
      expect(globalCallback).toHaveBeenCalledWith(resourceEvent);
      expect(globalCallback).toHaveBeenCalledTimes(1);
    });

    it('should publish resource events to global subscribers even without resource-scoped subscribers', async () => {
      const rid = resourceId('doc1');
      const globalCallback = vi.fn();

      // Only subscribe globally, not resource-scoped
      bus.subscribeGlobal(globalCallback);

      const resourceEvent: StoredEvent = {
        event: {
          id: 'event1',
          type: 'resource.archived',
          timestamp: new Date().toISOString(),
          userId: userId('user1'),
          resourceId: rid,
          version: 2,
          payload: {},
        },
        metadata: createEventMetadata(2),
      };

      await bus.publish(resourceEvent);

      // Global callback should still receive resource events
      expect(globalCallback).toHaveBeenCalledWith(resourceEvent);
      expect(globalCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribe()', () => {
    it('should subscribe to resource events', () => {
      const rid = resourceId('doc1');
      const callback = vi.fn();

      const subscription = bus.subscribe(rid, callback);

      expect(subscription).toBeDefined();
      expect(subscription.resourceUri).toBe('http://localhost:4000/resources/doc1');
      expect(subscription.callback).toBe(callback);
      expect(subscription.unsubscribe).toBeInstanceOf(Function);
    });

    it('should convert ResourceId to ResourceUri internally', () => {
      const rid = resourceId('doc1');
      const callback = vi.fn();

      bus.subscribe(rid, callback);

      const count = bus.getSubscriberCount(rid);
      expect(count).toBe(1);
    });

    it('should support multiple subscribers for same resource', () => {
      const rid = resourceId('doc1');
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      bus.subscribe(rid, callback1);
      bus.subscribe(rid, callback2);

      expect(bus.getSubscriberCount(rid)).toBe(2);
    });
  });

  describe('subscribeGlobal()', () => {
    it('should subscribe to global events', () => {
      const callback = vi.fn();

      const subscription = bus.subscribeGlobal(callback);

      expect(subscription).toBeDefined();
      expect(subscription.resourceUri).toBe('__global__');
      expect(subscription.callback).toBe(callback);
      expect(subscription.unsubscribe).toBeInstanceOf(Function);
    });

    it('should support multiple global subscribers', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      bus.subscribeGlobal(callback1);
      bus.subscribeGlobal(callback2);

      expect(bus.getGlobalSubscriptionCount()).toBe(2);
    });
  });

  describe('unsubscribe()', () => {
    it('should unsubscribe from resource events', () => {
      const rid = resourceId('doc1');
      const callback = vi.fn();

      bus.subscribe(rid, callback);
      expect(bus.getSubscriberCount(rid)).toBe(1);

      bus.unsubscribe(rid, callback);
      expect(bus.getSubscriberCount(rid)).toBe(0);
    });

    it('should handle unsubscribe when not subscribed', () => {
      const rid = resourceId('doc1');
      const callback = vi.fn();

      expect(() => bus.unsubscribe(rid, callback)).not.toThrow();
      expect(bus.getSubscriberCount(rid)).toBe(0);
    });

    it('should only remove specific callback', () => {
      const rid = resourceId('doc1');
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      bus.subscribe(rid, callback1);
      bus.subscribe(rid, callback2);
      expect(bus.getSubscriberCount(rid)).toBe(2);

      bus.unsubscribe(rid, callback1);
      expect(bus.getSubscriberCount(rid)).toBe(1);
    });
  });

  describe('unsubscribeGlobal()', () => {
    it('should unsubscribe from global events', () => {
      const callback = vi.fn();

      bus.subscribeGlobal(callback);
      expect(bus.getGlobalSubscriptionCount()).toBe(1);

      bus.unsubscribeGlobal(callback);
      expect(bus.getGlobalSubscriptionCount()).toBe(0);
    });

    it('should handle unsubscribe when not subscribed', () => {
      const callback = vi.fn();

      expect(() => bus.unsubscribeGlobal(callback)).not.toThrow();
      expect(bus.getGlobalSubscriptionCount()).toBe(0);
    });
  });

  describe('getSubscriberCount()', () => {
    it('should return 0 for resource with no subscribers', () => {
      const rid = resourceId('doc1');
      expect(bus.getSubscriberCount(rid)).toBe(0);
    });

    it('should return correct count for resource with subscribers', () => {
      const rid = resourceId('doc1');
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      bus.subscribe(rid, callback1);
      bus.subscribe(rid, callback2);
      bus.subscribe(rid, callback3);

      expect(bus.getSubscriberCount(rid)).toBe(3);
    });
  });

  describe('getTotalSubscriptions()', () => {
    it('should return 0 when no subscriptions', () => {
      expect(bus.getTotalSubscriptions()).toBe(0);
    });

    it('should return total across all resources', () => {
      const rid1 = resourceId('doc1');
      const rid2 = resourceId('doc2');

      bus.subscribe(rid1, vi.fn());
      bus.subscribe(rid1, vi.fn());
      bus.subscribe(rid2, vi.fn());

      expect(bus.getTotalSubscriptions()).toBe(3);
    });
  });

  describe('getGlobalSubscriptionCount()', () => {
    it('should return 0 when no global subscriptions', () => {
      expect(bus.getGlobalSubscriptionCount()).toBe(0);
    });

    it('should return correct global subscription count', () => {
      bus.subscribeGlobal(vi.fn());
      bus.subscribeGlobal(vi.fn());
      bus.subscribeGlobal(vi.fn());

      expect(bus.getGlobalSubscriptionCount()).toBe(3);
    });
  });

  describe('Subscription lifecycle', () => {
    it('should support unsubscribe via subscription object', () => {
      const rid = resourceId('doc1');
      const callback = vi.fn();

      const subscription = bus.subscribe(rid, callback);
      expect(bus.getSubscriberCount(rid)).toBe(1);

      subscription.unsubscribe();
      expect(bus.getSubscriberCount(rid)).toBe(0);
    });

    it('should support re-subscribing after unsubscribe', () => {
      const rid = resourceId('doc1');
      const callback = vi.fn();

      const sub1 = bus.subscribe(rid, callback);
      sub1.unsubscribe();

      bus.subscribe(rid, callback);
      expect(bus.getSubscriberCount(rid)).toBe(1);
    });
  });
});
