/**
 * EventStore - Orchestration Layer
 *
 * Coordinates event sourcing operations across 3 focused components:
 * - EventLog: Event persistence (append, retrieve, query)
 * - EventBus: Pub/sub notifications (publish, subscribe)
 * - ViewManager: View updates (resource and system)
 *
 * Thin coordination layer - delegates all work to specialized components.
 *
 * @see docs/EVENT-STORE.md for complete architecture documentation
 */

import type {
  ResourceEvent,
  StoredEvent,
  ResourceId,
  Logger,
} from '@semiont/core';
import { EventBus as CoreEventBus } from '@semiont/core';
import type { ViewStorage } from './storage/view-storage';
import type { IdentifierConfig } from './identifier-utils';

// Import focused components
import { EventLog, type EventLogConfig } from './event-log';
import { EventBus, type EventBusConfig } from './event-bus';
import { ViewManager, type ViewManagerConfig } from './view-manager';
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
  readonly views: ViewManager;
  readonly viewStorage: ViewStorage;
  readonly coreEventBus?: CoreEventBus;

  constructor(
    config: EventStorageConfig,
    viewStorage: ViewStorage,
    identifierConfig: IdentifierConfig,
    coreEventBus?: CoreEventBus,
    logger?: Logger
  ) {
    // Store viewStorage for direct access
    this.viewStorage = viewStorage;
    this.coreEventBus = coreEventBus;

    // Initialize focused components
    const logConfig: EventLogConfig = {
      basePath: config.basePath,
      dataDir: config.dataDir,
      enableSharding: config.enableSharding,
      maxEventsPerFile: config.maxEventsPerFile,
    };
    this.log = new EventLog(logConfig, logger?.child({ component: 'EventLog' }));

    const busConfig: EventBusConfig = {
      identifierConfig,
    };
    this.bus = new EventBus(busConfig, logger?.child({ component: 'EventBus' }));

    const viewConfig: ViewManagerConfig = {
      basePath: config.basePath,
      backendUrl: identifierConfig.baseUrl,
    };
    this.views = new ViewManager(viewStorage, viewConfig, logger?.child({ component: 'ViewManager' }));
  }

  /**
   * Append an event to the store
   * Coordinates: persistence → view → notification
   */
  async appendEvent(event: Omit<ResourceEvent, 'id' | 'timestamp'>): Promise<StoredEvent> {
    // System-level events (entitytype.added) have no resourceId - use __system__
    const resourceId: ResourceId | '__system__' = event.resourceId || '__system__';

    // 1. Persist event to log
    const storedEvent = await this.log.append(event, resourceId as any);

    // 2. Update views
    if (resourceId === '__system__') {
      // System-level view (entity types, etc.)
      await this.views.materializeSystem(
        storedEvent.event.type,
        storedEvent.event.payload
      );
    } else {
      // Resource view
      await this.views.materializeResource(
        resourceId as ResourceId,
        storedEvent.event,
        () => this.log.getEvents(resourceId as ResourceId)
      );
    }

    // 3. Notify subscribers (legacy event bus)
    await this.bus.publish(storedEvent);

    // 4. Publish to @semiont/core EventBus if provided (domain events)
    if (this.coreEventBus && resourceId !== '__system__') {
      // Use resource-scoped bus for isolation
      const scopedBus = this.coreEventBus.scope(resourceId as string);

      // Publish to specific event type channel (convert dot notation to colon notation)
      // e.g., type: 'job.completed' → channel 'job:completed'
      const eventChannel = storedEvent.event.type.replace(/\./g, ':') as any;
      scopedBus.get(eventChannel).next(storedEvent.event);

      // Also publish to generic 'make-meaning:event' channel for broad subscribers
      scopedBus.get('make-meaning:event').next(storedEvent.event);
    }

    return storedEvent;
  }
}
