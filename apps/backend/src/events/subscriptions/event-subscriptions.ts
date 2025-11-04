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

import type { StoredEvent } from '@semiont/core';
import type { ResourceUri } from '@semiont/api-client';

export type EventCallback = (event: StoredEvent) => void | Promise<void>;

export interface EventSubscription {
  resourceUri: ResourceUri;
  callback: EventCallback;
  unsubscribe: () => void;
}

/**
 * EventSubscriptions manages real-time event pub/sub
 * Supports both resource-scoped and global subscriptions
 */
export class EventSubscriptions {
  // Per-resource subscriptions: ResourceUri -> Set of callbacks
  private subscriptions: Map<ResourceUri, Set<EventCallback>> = new Map();
  // Global subscriptions for system-level events (no resourceId)
  private globalSubscriptions: Set<EventCallback> = new Set();

  /**
   * Subscribe to events for a specific resource using full URI
   * Returns an EventSubscription with unsubscribe function
   */
  subscribe(resourceUri: ResourceUri, callback: EventCallback): EventSubscription {
    if (!this.subscriptions.has(resourceUri)) {
      this.subscriptions.set(resourceUri, new Set());
    }

    const callbacks = this.subscriptions.get(resourceUri)!;
    callbacks.add(callback);

    console.log(`[EventSubscriptions] Subscription added for resource ${resourceUri} (total: ${callbacks.size} subscribers)`);

    return {
      resourceUri,
      callback,
      unsubscribe: () => {
        callbacks.delete(callback);
        console.log(`[EventSubscriptions] Subscription removed for resource ${resourceUri} (remaining: ${callbacks.size} subscribers)`);
        if (callbacks.size === 0) {
          this.subscriptions.delete(resourceUri);
          console.log(`[EventSubscriptions] No more subscribers for resource ${resourceUri}, removed from subscriptions map`);
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

    console.log(`[EventSubscriptions] Global subscription added (total: ${this.globalSubscriptions.size} subscribers)`);

    return {
      resourceUri: '__global__' as ResourceUri,  // Special marker for global subscriptions
      callback,
      unsubscribe: () => {
        this.globalSubscriptions.delete(callback);
        console.log(`[EventSubscriptions] Global subscription removed (remaining: ${this.globalSubscriptions.size} subscribers)`);
      }
    };
  }

  /**
   * Notify all subscribers for a resource when a new event is appended
   * @param resourceUri - Full resource URI (e.g., http://localhost:4000/resources/abc123)
   */
  async notifySubscribers(resourceUri: ResourceUri, event: StoredEvent): Promise<void> {
    const callbacks = this.subscriptions.get(resourceUri);
    if (!callbacks || callbacks.size === 0) {
      console.log(`[EventSubscriptions] Event ${event.event.type} for resource ${resourceUri} - no subscribers to notify`);
      return;
    }

    console.log(`[EventSubscriptions] Notifying ${callbacks.size} subscriber(s) of event ${event.event.type} for resource ${resourceUri}`);

    // Call all callbacks without waiting - fire and forget
    // Each callback handles its own errors and cleanup
    // This prevents slow/hanging callbacks from blocking event emission
    Array.from(callbacks).forEach((callback, index) => {
      Promise.resolve(callback(event))
        .then(() => {
          console.log(`[EventSubscriptions] Subscriber #${index + 1} successfully notified of ${event.event.type}`);
        })
        .catch((error: unknown) => {
          console.error(`[EventSubscriptions] Error in subscriber #${index + 1} for resource ${resourceUri}, event ${event.event.type}:`, error);
        });
    });
  }

  /**
   * Notify all global subscribers when a system-level event is appended
   */
  async notifyGlobalSubscribers(event: StoredEvent): Promise<void> {
    if (this.globalSubscriptions.size === 0) {
      console.log(`[EventSubscriptions] System event ${event.event.type} - no global subscribers to notify`);
      return;
    }

    console.log(`[EventSubscriptions] Notifying ${this.globalSubscriptions.size} global subscriber(s) of system event ${event.event.type}`);

    // Call all global callbacks without waiting - fire and forget
    // Each callback handles its own errors and cleanup
    // This prevents slow/hanging callbacks from blocking event emission
    Array.from(this.globalSubscriptions).forEach((callback, index) => {
      Promise.resolve(callback(event))
        .then(() => {
          console.log(`[EventSubscriptions] Global subscriber #${index + 1} successfully notified of ${event.event.type}`);
        })
        .catch((error: unknown) => {
          console.error(`[EventSubscriptions] Error in global subscriber #${index + 1} for system event ${event.event.type}:`, error);
        });
    });
  }

  /**
   * Get subscription count for a resource (useful for debugging)
   */
  getSubscriptionCount(resourceUri: ResourceUri): number {
    return this.subscriptions.get(resourceUri)?.size || 0;
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

export function getEventSubscriptions(): EventSubscriptions {
  if (!globalEventSubscriptions) {
    globalEventSubscriptions = new EventSubscriptions();
    console.log('[EventSubscriptions] Created global singleton instance');
  }
  return globalEventSubscriptions;
}
