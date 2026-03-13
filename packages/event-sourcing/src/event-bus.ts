/**
 * EventBus - Event Pub/Sub Layer
 *
 * Single Responsibility: Event pub/sub only
 * - Publishes events to subscribers
 * - Manages subscriptions (resource-scoped and global)
 *
 * Does NOT handle:
 * - Event persistence (see EventLog)
 * - View updates (see ViewManager)
 */

import { type StoredEvent, type ResourceId, resourceId as makeResourceId, isResourceEvent, isSystemEvent, type Logger } from '@semiont/core';
import { getEventSubscriptions, type EventSubscriptions, type EventCallback, type EventSubscription } from './subscriptions/event-subscriptions';

/**
 * EventBus wraps EventSubscriptions with a clean API
 * Uses bare ResourceId for subscriptions
 */
export class EventBus {
  // Expose subscriptions for direct access
  readonly subscriptions: EventSubscriptions;
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
    // Use global singleton EventSubscriptions to ensure all EventBus instances
    // share the same subscription registry (critical for SSE real-time events)
    this.subscriptions = getEventSubscriptions(logger?.child({ component: 'EventSubscriptions' }));
  }

  /**
   * Publish event to subscribers
   * - Resource events: notifies BOTH resource-scoped AND global subscribers
   * - System events: notifies global subscribers only
   * @param event - Stored event (from @semiont/core)
   */
  async publish(event: StoredEvent): Promise<void> {
    if (isSystemEvent(event.event)) {
      // System-level event - notify global subscribers
      await this.subscriptions.notifyGlobalSubscribers(event);
    } else if (isResourceEvent(event.event)) {
      // Resource event - notify BOTH resource-scoped AND global subscribers
      // This enables projections (graph, search, etc.) to use global subscription
      const rid = makeResourceId(event.event.resourceId as string);
      await this.subscriptions.notifySubscribers(rid, event);
      await this.subscriptions.notifyGlobalSubscribers(event);
    } else {
      // Shouldn't happen - events should be either resource or system
      this.logger?.warn('[EventBus] Event is neither resource nor system event', { eventType: (event.event as any).type });
    }
  }

  /**
   * Subscribe to events for a specific resource
   * @param resourceId - Branded ResourceId (from @semiont/core)
   * @param callback - Event callback function
   * @returns EventSubscription with unsubscribe function
   */
  subscribe(resourceId: ResourceId, callback: EventCallback): EventSubscription {
    return this.subscriptions.subscribe(resourceId, callback);
  }

  /**
   * Subscribe to all system-level events
   * @param callback - Event callback function
   * @returns EventSubscription with unsubscribe function
   */
  subscribeGlobal(callback: EventCallback): EventSubscription {
    return this.subscriptions.subscribeGlobal(callback);
  }

  /**
   * Unsubscribe from resource events
   * @param resourceId - Branded ResourceId (from @semiont/core)
   * @param callback - Event callback function to remove
   */
  unsubscribe(resourceId: ResourceId, callback: EventCallback): void {
    const callbacks = (this.subscriptions as any).subscriptions.get(resourceId);
    if (callbacks) {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        (this.subscriptions as any).subscriptions.delete(resourceId);
      }
    }
  }

  /**
   * Unsubscribe from global events
   * @param callback - Event callback function to remove
   */
  unsubscribeGlobal(callback: EventCallback): void {
    (this.subscriptions as any).globalSubscriptions.delete(callback);
  }

  /**
   * Get subscriber count for a resource
   * @param resourceId - Branded ResourceId (from @semiont/core)
   * @returns Number of active subscribers
   */
  getSubscriberCount(resourceId: ResourceId): number {
    return this.subscriptions.getSubscriptionCount(resourceId);
  }

  /**
   * Get total number of active subscriptions across all resources
   */
  getTotalSubscriptions(): number {
    return this.subscriptions.getTotalSubscriptions();
  }

  /**
   * Get total number of global subscriptions
   */
  getGlobalSubscriptionCount(): number {
    return this.subscriptions.getGlobalSubscriptionCount();
  }
}
