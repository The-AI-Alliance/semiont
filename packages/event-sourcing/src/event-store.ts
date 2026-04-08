/**
 * EventStore - Orchestration Layer
 *
 * Coordinates event sourcing operations:
 * - EventLog: Event persistence (append, retrieve, query)
 * - ViewManager: View materialization (resource and system)
 * - Core EventBus: Publishes StoredEvent to typed channels after persistence
 *
 * appendEvent() is the single write path:
 *   1. Persist to EventLog
 *   2. Materialize views
 *   3. Publish StoredEvent to global and resource-scoped typed channels
 */

import type {
  ResourceEvent,
  StoredEvent,
  ResourceId,
  Logger,
} from '@semiont/core';
import { EventBus as CoreEventBus } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import type { ViewStorage } from './storage/view-storage';
// Import focused components
import { EventLog } from './event-log';
import { ViewManager, type ViewManagerConfig } from './view-manager';

/**
 * EventStore orchestrates event sourcing operations
 * Delegates to specialized components for focused functionality
 * NO state - just coordination between components
 */
export class EventStore {
  // Focused components - each with single responsibility
  readonly log: EventLog;
  readonly views: ViewManager;
  readonly viewStorage: ViewStorage;
  readonly coreEventBus: CoreEventBus;

  constructor(
    project: SemiontProject,
    stateDir: string,
    viewStorage: ViewStorage,
    coreEventBus: CoreEventBus,
    logger?: Logger
  ) {
    // Store viewStorage for direct access
    this.viewStorage = viewStorage;
    this.coreEventBus = coreEventBus;

    // Initialize focused components
    this.log = new EventLog({ project }, logger?.child({ component: 'EventLog' }));

    const viewConfig: ViewManagerConfig = {
      basePath: stateDir,
    };
    this.views = new ViewManager(viewStorage, viewConfig, logger?.child({ component: 'ViewManager' }));
  }

  /**
   * Append an event to the store
   * Coordinates: persistence → view → notification
   */
  async appendEvent(event: Omit<ResourceEvent, 'id' | 'timestamp'>): Promise<StoredEvent> {
    // System-level events (mark:entity-type-added) have no resourceId - use __system__
    const resourceId: ResourceId | '__system__' = event.resourceId || '__system__';

    // 1. Persist event to log
    const storedEvent = await this.log.append(event, resourceId as any);

    // 2. Update views
    if (resourceId === '__system__') {
      // System-level view (entity types, etc.)
      await this.views.materializeSystem(
        storedEvent.type,
        storedEvent.payload
      );
    } else {
      // Resource view
      await this.views.materializeResource(
        resourceId as ResourceId,
        storedEvent,
        () => this.log.getEvents(resourceId as ResourceId)
      );
    }

    // 3. Publish full StoredEvent to Core EventBus typed channels
    // Global typed channel (e.g., 'mark:added')
    this.coreEventBus.get(storedEvent.type as any).next(storedEvent);

    // Resource-scoped typed channel for per-resource subscribers
    if (resourceId !== '__system__') {
      const scopedBus = this.coreEventBus.scope(resourceId as string);
      scopedBus.get(storedEvent.type as any).next(storedEvent);
    }

    return storedEvent;
  }
}
