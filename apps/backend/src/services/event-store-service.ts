/**
 * Event Store Service - Dependency Injection
 *
 * Single initialization point for EventStore and all its dependencies.
 * No singleton pattern - just a simple factory function.
 * No getFilesystemConfig - requires explicit basePath.
 */

import * as path from 'path';
import { EventStore, type EventStoreConfig } from '../events/event-store';
import { EventQuery } from '../events/query/event-query';
import { EventValidator } from '../events/validation/event-validator';
import { createProjectionManager, getBasePath } from './storage-service';

export interface EventStoreServiceConfig extends EventStoreConfig {
  basePath?: string;  // Optional: Base filesystem path (defaults to environment config)
}

/**
 * Create and initialize an EventStore instance
 * This is the ONE place where EventStore is instantiated
 *
 * @param config - Optional configuration
 */
export async function createEventStore(config?: EventStoreServiceConfig): Promise<EventStore> {
  // Get base path from config or environment
  const basePath = config?.basePath || getBasePath();

  // Create ProjectionManager (Layer 3)
  // Structure: <basePath>/projections/documents/...
  const projectionManager = createProjectionManager({
    basePath,
    subNamespace: 'documents',
  });

  // Determine data directory for events (Layer 2)
  // Structure: <dataDir>/events/...
  const dataDir = config?.dataDir || path.join(basePath, 'events');

  const eventStore = new EventStore({
    ...config,
    dataDir,
    enableSharding: true,
    numShards: 65536,  // 4 hex digits
  }, projectionManager);

  return eventStore;
}

/**
 * Create EventQuery instance
 * Consumers use this for read operations
 */
export function createEventQuery(eventStore: EventStore): EventQuery {
  return new EventQuery(eventStore.storage);
}

/**
 * Create EventValidator instance
 * Consumers use this for validation operations
 */
export function createEventValidator(): EventValidator {
  return new EventValidator();
}
