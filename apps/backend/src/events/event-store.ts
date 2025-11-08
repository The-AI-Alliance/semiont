/**
 * EventStore - Orchestration Layer
 *
 * Coordinates event sourcing operations across 3 focused components:
 * - EventLog: Event persistence (append, retrieve, query)
 * - EventBus: Pub/sub notifications (publish, subscribe)
 * - ProjectionManager: Projection updates (resource and system)
 *
 * Thin coordination layer - delegates all work to specialized components.
 *
 * @see docs/EVENT-STORE.md for complete architecture documentation
 */

import type {
  ResourceEvent,
  StoredEvent,
  ResourceId,
} from '@semiont/core';
import type { ProjectionStorage } from '../storage/projection-storage';
import type { IdentifierConfig } from '../services/identifier-service';

// Import focused components
import { EventLog, type EventLogConfig } from './event-log';
import { EventBus, type EventBusConfig } from './event-bus';
import { ProjectionManager, type ProjectionManagerConfig } from './projection-manager';
import type { EventStorageConfig } from './storage/event-storage';

/**
 * EventStore orchestrates event sourcing operations
 * Delegates to specialized components for focused functionality
 * NO state - just coordination between components
 */
export class EventStore {
  // Focused components - each with single responsibility
  readonly log: EventLog;
  readonly bus: EventBus;
  readonly projections: ProjectionManager;

  constructor(
    config: EventStorageConfig,
    projectionStorage: ProjectionStorage,
    identifierConfig: IdentifierConfig
  ) {
    // Initialize focused components
    const logConfig: EventLogConfig = {
      basePath: config.basePath,
      dataDir: config.dataDir,
      enableSharding: config.enableSharding,
      maxEventsPerFile: config.maxEventsPerFile,
    };
    this.log = new EventLog(logConfig);

    const busConfig: EventBusConfig = {
      identifierConfig,
    };
    this.bus = new EventBus(busConfig);

    const projectionConfig: ProjectionManagerConfig = {
      basePath: config.basePath,
      backendUrl: identifierConfig.baseUrl,
    };
    this.projections = new ProjectionManager(projectionStorage, projectionConfig);
  }

  /**
   * Append an event to the store
   * Coordinates: persistence → projection → notification
   */
  async appendEvent(event: Omit<ResourceEvent, 'id' | 'timestamp'>): Promise<StoredEvent> {
    // System-level events (entitytype.added) have no resourceId - use __system__
    const resourceId: ResourceId | '__system__' = event.resourceId || '__system__';

    // 1. Persist event to log
    const storedEvent = await this.log.append(event, resourceId as any);

    // 2. Update projections
    if (resourceId === '__system__') {
      // System-level projection (entity types, etc.)
      await this.projections.updateSystemProjection(
        storedEvent.event.type,
        storedEvent.event.payload
      );
    } else {
      // Resource projection
      await this.projections.updateResourceProjection(
        resourceId as ResourceId,
        storedEvent.event,
        () => this.log.getEvents(resourceId as ResourceId)
      );
    }

    // 3. Notify subscribers (handles both resource and global subscriptions)
    await this.bus.publish(storedEvent);

    return storedEvent;
  }
}
