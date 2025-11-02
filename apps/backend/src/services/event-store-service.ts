/**
 * Event Store Service - Dependency Injection
 *
 * Single initialization point for EventStore and all its dependencies.
 * No singleton pattern - just a simple factory function.
 * NO getFilesystemConfig calls - requires EXPLICIT basePath from caller
 * NO fallbacks - basePath is REQUIRED
 */

import * as path from 'path';
import { EventStore } from '../events/event-store';
import type { EventStorageConfig } from '../events/storage/event-storage';
import { EventQuery } from '../events/query/event-query';
import { EventValidator } from '../events/validation/event-validator';
import { createProjectionManager } from './storage-service';
import { getBackendConfig } from '../config/environment-loader';
import type { IdentifierConfig } from './identifier-service';

/**
 * Create and initialize an EventStore instance
 * This is the ONE place where EventStore is instantiated
 *
 * @param basePath - REQUIRED: Base filesystem path for all storage
 * @param config - Optional additional configuration
 */
export async function createEventStore(
  basePath: string,
  config?: Omit<EventStorageConfig, 'basePath' | 'dataDir'>
): Promise<EventStore> {
  // Get backend config for identifier conversion
  const backendConfig = getBackendConfig();
  const identifierConfig: IdentifierConfig = {
    baseUrl: backendConfig.publicURL
  };

  // Create ProjectionManager (Layer 3)
  // Structure: <basePath>/projections/resources/...
  const projectionManager = createProjectionManager(basePath, {
    subNamespace: 'resources',
  });

  // Determine data directory for events (Layer 2)
  // Structure: <basePath>/events/...
  const dataDir = path.join(basePath, 'events');

  const eventStore = new EventStore({
    ...config,
    basePath,
    dataDir,
    enableSharding: true,
    numShards: 65536,  // 4 hex digits
  }, projectionManager, identifierConfig);

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
