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
} from '@semiont/core';
import { isSystemEvent } from '@semiont/core';
import type { ProjectionStorage } from '../storage/projection-storage';

// Import extracted modules
import { EventStorage, type EventStorageConfig } from './storage/event-storage';
import { EventProjector, type ProjectorConfig } from './projections/event-projector';
import { getEventSubscriptions, type EventSubscriptions } from './subscriptions/event-subscriptions';
import { getBackendConfig } from '../config/environment-loader';

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

  constructor(config: EventStorageConfig, projectionStorage: ProjectionStorage) {
    // Initialize modules
    this.storage = new EventStorage(config);

    const projectorConfig: ProjectorConfig = {
      basePath: config.basePath,
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
    // Determine storage location based on event type
    // System events use special '__system__' shard, resource events use their resourceId
    const resourceId = event.resourceId || '__system__';

    // Storage handles ALL event creation
    const storedEvent = await this.storage.appendEvent(event, resourceId);

    // Route to appropriate projection and notification based on event type
    if (isSystemEvent(storedEvent.event)) {
      // System-level event: Update global projection
      await this.projector.updateEntityTypesProjection(storedEvent.event.payload.entityType);
      // Notify global subscribers
      await this.subscriptions.notifyGlobalSubscribers(storedEvent);
    } else {
      // Resource-scoped event: Update resource projection
      if (!storedEvent.event.resourceId) {
        throw new Error(`Resource-scoped event ${storedEvent.event.type} missing resourceId`);
      }
      await this.projector.updateProjectionIncremental(
        storedEvent.event.resourceId,
        storedEvent.event,
        () => this.storage.getAllEvents(storedEvent.event.resourceId!)
      );
      // Notify resource subscribers using full URI (W3C Web Annotation spec compliance)
      // Convert short resource ID to full URI at the publication boundary (if not already a URI)
      const backendConfig = getBackendConfig();
      const resourceUri = storedEvent.event.resourceId.includes('/')
        ? storedEvent.event.resourceId  // Already a full URI
        : `${backendConfig.publicURL}/resources/${storedEvent.event.resourceId}`;  // Short ID, construct URI
      await this.subscriptions.notifySubscribers(resourceUri, storedEvent);
    }

    return storedEvent;
  }

}
