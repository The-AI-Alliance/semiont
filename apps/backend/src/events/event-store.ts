/**
 * Event Store - Orchestration Layer
 *
 * Coordinates event sourcing operations across 3 modules:
 * - EventStorage: File I/O, sequence tracking, checksums
 * - EventProjector: Build projections from events
 * - EventSubscriptions: Real-time pub/sub notifications
 *
 * 82 lines. Pure coordination. Zero cruft.
 *
 * @see docs/EVENT-STORE.md for complete architecture resourceation
 */

import type {
  ResourceEvent,
  StoredEvent,
  ResourceId,
} from '@semiont/core';
import type { ProjectionStorage } from '../storage/projection-storage';
import { toResourceUri, type IdentifierConfig } from '../services/identifier-service';

// Import extracted modules
import { EventStorage, type EventStorageConfig } from './storage/event-storage';
import { EventProjector, type ProjectorConfig } from './projections/event-projector';
import { getEventSubscriptions, type EventSubscriptions } from './subscriptions/event-subscriptions';

/**
 * EventStore orchestrates event sourcing operations
 * Delegates to specialized modules for focused functionality
 * NO state - just coordination between modules
 */
export class EventStore {
  // Public module access - only what's needed for coordination
  readonly storage: EventStorage;
  readonly projector: EventProjector;
  readonly subscriptions: EventSubscriptions;

  constructor(
    config: EventStorageConfig,
    projectionStorage: ProjectionStorage,
    private identifierConfig: IdentifierConfig
  ) {
    // Initialize modules
    this.storage = new EventStorage(config);

    const projectorConfig: ProjectorConfig = {
      basePath: config.basePath,
      backendUrl: identifierConfig.baseUrl,
    };
    this.projector = new EventProjector(projectionStorage, projectorConfig);

    // Use global singleton EventSubscriptions to ensure all EventStore instances
    // share the same subscription registry (critical for SSE real-time events)
    this.subscriptions = getEventSubscriptions();
  }

  /**
   * Append an event to the store
   * Coordinates: storage → projection → notification
   */
  async appendEvent(event: Omit<ResourceEvent, 'id' | 'timestamp'>): Promise<StoredEvent> {
    // System-level events (entitytype.added) have no resourceId - use __system__
    const resourceId: ResourceId | '__system__' = event.resourceId || '__system__';

    // Storage handles ALL event creation
    const storedEvent = await this.storage.appendEvent(event, resourceId as any);

    // Update projections (Layer 3)
    if (resourceId === '__system__') {
      // System projection (entity types)
      if (storedEvent.event.type === 'entitytype.added') {
        const payload = storedEvent.event.payload as any;
        await this.projector.updateEntityTypesProjection(payload.entityType);
      }
      // Notify global subscribers
      await this.subscriptions.notifyGlobalSubscribers(storedEvent);
    } else {
      // Resource projection
      await this.projector.updateProjectionIncremental(
        resourceId as ResourceId,
        storedEvent.event,
        () => this.storage.getAllEvents(resourceId as ResourceId)
      );
      // Notify resource subscribers - convert ID to URI for type safety
      const resourceUri = toResourceUri(this.identifierConfig, resourceId as ResourceId);
      await this.subscriptions.notifySubscribers(resourceUri, storedEvent);
    }

    return storedEvent;
  }

}
