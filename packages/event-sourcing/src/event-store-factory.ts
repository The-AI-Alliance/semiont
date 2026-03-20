/**
 * Event Store Factory
 *
 * Factory function for creating EventStore instances with standard configuration.
 * This is the canonical way to instantiate an EventStore.
 */

import type { EventBus as CoreEventBus, Logger, SemiontProject } from '@semiont/core';
import { EventStore } from './event-store';
import { FilesystemViewStorage } from './storage/view-storage';
import type { EventStorageConfig } from './storage/event-storage';

/**
 * Create and initialize an EventStore instance
 *
 * @param basePath - Absolute path to the data directory (must be resolved by caller)
 * @param config - Optional additional storage configuration
 * @param eventBus - Optional @semiont/core EventBus for publishing domain events
 * @param logger - Optional logger for structured logging
 * @returns Configured EventStore instance ready for use
 *
 * @example
 * ```typescript
 * const eventStore = createEventStore('/absolute/path/to/data');
 * await eventStore.appendEvent({
 *   type: 'resource.created',
 *   resourceId: 'doc-123',
 *   userId: 'user-456',
 *   version: 1,
 *   payload: { name: 'My Document' }
 * });
 * ```
 */
export function createEventStore(
  project: SemiontProject,
  config?: Partial<EventStorageConfig>,
  eventBus?: CoreEventBus,
  logger?: Logger
): EventStore {
  const viewStorage = new FilesystemViewStorage(project, logger?.child({ component: 'view-storage' }));

  return new EventStore(
    {
      ...config,
      basePath: project.dataDir,
      dataDir: project.eventsDir,
      enableSharding: true,
      numShards: 65536, // 4 hex digits (0000-ffff)
    },
    project.stateDir,
    viewStorage,
    eventBus,
    logger
  );
}
