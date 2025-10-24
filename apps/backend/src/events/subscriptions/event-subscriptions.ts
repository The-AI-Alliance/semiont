/**
 * Event Subscriptions - Real-time Event Pub/Sub
 *
 * Manages subscriptions for both document-scoped and system-level events:
 * - Document subscriptions: notifications for a specific document's events
 * - Global subscriptions: notifications for all system-level events
 * - Fire-and-forget notification pattern (non-blocking)
 * - Automatic cleanup of empty subscription sets
 *
 * @see docs/EVENT-STORE.md#eventsubscriptions for architecture details
 */

import type { StoredEvent } from '@semiont/core';

export type EventCallback = (event: StoredEvent) => void | Promise<void>;

export interface EventSubscription {
  documentId: string;
  callback: EventCallback;
  unsubscribe: () => void;
}

/**
 * EventSubscriptions manages real-time event pub/sub
 * Supports both document-scoped and global subscriptions
 */
export class EventSubscriptions {
  // Per-document subscriptions: documentId -> Set of callbacks
  private subscriptions: Map<string, Set<EventCallback>> = new Map();
  // Global subscriptions for system-level events (no documentId)
  private globalSubscriptions: Set<EventCallback> = new Set();

  /**
   * Subscribe to events for a specific document
   * Returns an EventSubscription with unsubscribe function
   */
  subscribe(documentId: string, callback: EventCallback): EventSubscription {
    if (!this.subscriptions.has(documentId)) {
      this.subscriptions.set(documentId, new Set());
    }

    const callbacks = this.subscriptions.get(documentId)!;
    callbacks.add(callback);

    console.log(`[EventSubscriptions] Subscription added for document ${documentId} (total: ${callbacks.size} subscribers)`);

    return {
      documentId,
      callback,
      unsubscribe: () => {
        callbacks.delete(callback);
        console.log(`[EventSubscriptions] Subscription removed for document ${documentId} (remaining: ${callbacks.size} subscribers)`);
        if (callbacks.size === 0) {
          this.subscriptions.delete(documentId);
          console.log(`[EventSubscriptions] No more subscribers for document ${documentId}, removed from subscriptions map`);
        }
      }
    };
  }

  /**
   * Subscribe to all system-level events (no documentId)
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
      documentId: '__global__',  // Special marker for global subscriptions
      callback,
      unsubscribe: () => {
        this.globalSubscriptions.delete(callback);
        console.log(`[EventSubscriptions] Global subscription removed (remaining: ${this.globalSubscriptions.size} subscribers)`);
      }
    };
  }

  /**
   * Notify all subscribers for a document when a new event is appended
   */
  async notifySubscribers(documentId: string, event: StoredEvent): Promise<void> {
    const callbacks = this.subscriptions.get(documentId);
    if (!callbacks || callbacks.size === 0) {
      console.log(`[EventSubscriptions] Event ${event.event.type} for document ${documentId} - no subscribers to notify`);
      return;
    }

    console.log(`[EventSubscriptions] Notifying ${callbacks.size} subscriber(s) of event ${event.event.type} for document ${documentId}`);

    // Call all callbacks without waiting - fire and forget
    // Each callback handles its own errors and cleanup
    // This prevents slow/hanging callbacks from blocking event emission
    Array.from(callbacks).forEach((callback, index) => {
      Promise.resolve(callback(event))
        .then(() => {
          console.log(`[EventSubscriptions] Subscriber #${index + 1} successfully notified of ${event.event.type}`);
        })
        .catch((error: unknown) => {
          console.error(`[EventSubscriptions] Error in subscriber #${index + 1} for document ${documentId}, event ${event.event.type}:`, error);
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
   * Get subscription count for a document (useful for debugging)
   */
  getSubscriptionCount(documentId: string): number {
    return this.subscriptions.get(documentId)?.size || 0;
  }

  /**
   * Get total number of active subscriptions across all documents
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
