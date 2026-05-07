/**
 * Event Store Factory
 *
 * Factory function for creating EventStore instances with standard configuration.
 * This is the canonical way to instantiate an EventStore.
 */

import type { SemiontProject } from '@semiont/core/node';
import type { EventBus as CoreEventBus, Logger } from '@semiont/core';
import { EventStore } from './event-store';
import { FilesystemViewStorage } from './storage/view-storage';

/**
 * Create and initialize an EventStore instance
 *
 * @param project - SemiontProject instance
 * @param eventBus - @semiont/core EventBus for publishing domain events
 * @param logger - Optional logger for structured logging
 * @returns Configured EventStore instance ready for use
 */
export function createEventStore(
  project: SemiontProject,
  eventBus: CoreEventBus,
  logger?: Logger
): EventStore {
  const viewStorage = new FilesystemViewStorage(project, logger?.child({ component: 'view-storage' }));

  return new EventStore(
    project,
    project.stateDir,
    viewStorage,
    eventBus,
    logger
  );
}
