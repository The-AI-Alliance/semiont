/**
 * Event Subscriptions - Real-time Event Pub/Sub
 *
 * Manages subscriptions for both resource-scoped and system-level events:
 * - Resource subscriptions: notifications for a specific resource's events
 * - Global subscriptions: notifications for all system-level events
 * - Fire-and-forget notification pattern (non-blocking)
 * - Automatic cleanup of empty subscription sets
 *
 * SINGLETON PATTERN: All EventStore instances share the same EventSubscriptions
 * to ensure SSE connections receive events from any EventStore instance.
 *
 * @see docs/EVENT-STORE.md#eventsubscriptions for architecture details
 */

import type { StoredEvent, ResourceId, Logger } from '@semiont/core';

export type EventCallback = (event: StoredEvent) => void | Promise<void>;

export interface EventSubscription {
  resourceId: ResourceId;
  callback: EventCallback;
  unsubscribe: () => void;
}

/**
 * EventSubscriptions manages real-time event pub/sub
 * Supports both resource-scoped and global subscriptions
 */
export class EventSubscriptions {
  // Per-resource subscriptions: ResourceId -> Set of callbacks
  private subscriptions: Map<ResourceId, Set<EventCallback>> = new Map();
  // Global subscriptions for system-level events (no resourceId)
  private globalSubscriptions: Set<EventCallback> = new Set();
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * Subscribe to events for a specific resource
   * Returns an EventSubscription with unsubscribe function
   */
  subscribe(resourceId: ResourceId, callback: EventCallback): EventSubscription {
    if (!this.subscriptions.has(resourceId)) {
      this.subscriptions.set(resourceId, new Set());
    }

    const callbacks = this.subscriptions.get(resourceId)!;
    callbacks.add(callback);

    this.logger?.info('[EventSubscriptions] Subscription added for resource', { resourceId, totalSubscribers: callbacks.size });

    return {
      resourceId,
      callback,
      unsubscribe: () => {
        callbacks.delete(callback);
        this.logger?.info('[EventSubscriptions] Subscription removed for resource', { resourceId, remainingSubscribers: callbacks.size });
        if (callbacks.size === 0) {
          this.subscriptions.delete(resourceId);
          this.logger?.info('[EventSubscriptions] No more subscribers for resource, removed from subscriptions map', { resourceId });
        }
      }
    };
  }

  /**
   * Subscribe to all system-level events (no resourceId)
   * Returns an EventSubscription with unsubscribe function
   *
   * Use this for consumers that need to react to global events like:
   * - entitytype.added (global entity type collection changes)
   * - Future system-level events (user.created, workspace.created, etc.)
   */
  subscribeGlobal(callback: EventCallback): EventSubscription {
    this.globalSubscriptions.add(callback);

    this.logger?.info('[EventSubscriptions] Global subscription added', { totalSubscribers: this.globalSubscriptions.size });

    return {
      resourceId: '__global__' as ResourceId,  // Special marker for global subscriptions
      callback,
      unsubscribe: () => {
        this.globalSubscriptions.delete(callback);
        this.logger?.info('[EventSubscriptions] Global subscription removed', { remainingSubscribers: this.globalSubscriptions.size });
      }
    };
  }

  /**
   * Notify all subscribers for a resource when a new event is appended
   * @param resourceId - Bare resource ID
   */
  async notifySubscribers(resourceId: ResourceId, event: StoredEvent): Promise<void> {
    const callbacks = this.subscriptions.get(resourceId);
    if (!callbacks || callbacks.size === 0) {
      this.logger?.info('[EventSubscriptions] Event - no subscribers to notify', { eventType: event.event.type, resourceId });
      return;
    }

    this.logger?.info('[EventSubscriptions] Notifying subscribers of event', { subscriberCount: callbacks.size, eventType: event.event.type, resourceId });

    // Call all callbacks without waiting - fire and forget
    // Each callback handles its own errors and cleanup
    // This prevents slow/hanging callbacks from blocking event emission
    Array.from(callbacks).forEach((callback, index) => {
      Promise.resolve(callback(event))
        .then(() => {
          this.logger?.info('[EventSubscriptions] Subscriber successfully notified', { subscriberIndex: index + 1, eventType: event.event.type });
        })
        .catch((error: unknown) => {
          this.logger?.error('[EventSubscriptions] Error in subscriber', { subscriberIndex: index + 1, resourceId, eventType: event.event.type, error });
        });
    });
  }

  /**
   * Notify all global subscribers when a system-level event is appended
   */
  async notifyGlobalSubscribers(event: StoredEvent): Promise<void> {
    if (this.globalSubscriptions.size === 0) {
      this.logger?.info('[EventSubscriptions] System event - no global subscribers to notify', { eventType: event.event.type });
      return;
    }

    this.logger?.info('[EventSubscriptions] Notifying global subscribers of system event', { subscriberCount: this.globalSubscriptions.size, eventType: event.event.type });

    // Call all global callbacks without waiting - fire and forget
    // Each callback handles its own errors and cleanup
    // This prevents slow/hanging callbacks from blocking event emission
    Array.from(this.globalSubscriptions).forEach((callback, index) => {
      Promise.resolve(callback(event))
        .then(() => {
          this.logger?.info('[EventSubscriptions] Global subscriber successfully notified', { subscriberIndex: index + 1, eventType: event.event.type });
        })
        .catch((error: unknown) => {
          this.logger?.error('[EventSubscriptions] Error in global subscriber', { subscriberIndex: index + 1, eventType: event.event.type, error });
        });
    });
  }

  /**
   * Get subscription count for a resource (useful for debugging)
   */
  getSubscriptionCount(resourceId: ResourceId): number {
    return this.subscriptions.get(resourceId)?.size || 0;
  }

  /**
   * Get total number of active subscriptions across all resources
   */
  getTotalSubscriptions(): number {
    let total = 0;
    for (const callbacks of this.subscriptions.values()) {
      total += callbacks.size;
    }
    return total;
  }

  /**
   * Get total number of global subscriptions
   */
  getGlobalSubscriptionCount(): number {
    return this.globalSubscriptions.size;
  }
}

// Singleton instance - shared across all EventStore instances
// This ensures SSE connections receive events from any EventStore instance
let globalEventSubscriptions: EventSubscriptions | null = null;

export function getEventSubscriptions(logger?: Logger): EventSubscriptions {
  if (!globalEventSubscriptions) {
    globalEventSubscriptions = new EventSubscriptions(logger);
    logger?.info('[EventSubscriptions] Created global singleton instance');
  }
  return globalEventSubscriptions;
}
