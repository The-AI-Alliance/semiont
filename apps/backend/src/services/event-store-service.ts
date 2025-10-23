/**
 * Event Store Service - Dependency Injection
 *
 * Single initialization point for EventStore and all its dependencies.
 * No singleton pattern - just a simple factory function.
 */

import * as path from 'path';
import { EventStore, type EventStoreConfig } from '../events/event-store';
import { EventQuery } from '../events/query/event-query';
import { EventValidator } from '../events/validation/event-validator';
import { getProjectionStorage } from '../storage/projection-storage';
import { getFilesystemConfig } from '../config/environment-loader';

/**
 * Create and initialize an EventStore instance
 * This is the ONE place where EventStore is instantiated
 */
export async function createEventStore(config?: EventStoreConfig): Promise<EventStore> {
  const projectionStorage = getProjectionStorage();

  // Determine data directory
  let dataDir: string;
  if (config?.dataDir) {
    dataDir = config.dataDir;
  } else {
    const filesystemConfig = getFilesystemConfig();
    dataDir = path.join(filesystemConfig.path, 'events');
  }

  const eventStore = new EventStore({
    dataDir,
    enableSharding: true,
    numShards: 65536,  // 4 hex digits
    ...config
  }, projectionStorage);


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
