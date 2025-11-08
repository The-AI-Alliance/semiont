/**
 * Event Store Service - Dependency Injection
 *
 * Single initialization point for EventStore and all its dependencies.
 * No singleton pattern - just a simple factory function.
 */

import * as path from 'path';
import type { EnvironmentConfig } from '@semiont/core';
import { EventStore } from '../events/event-store';
import type { EventStorageConfig } from '../events/storage/event-storage';
import type { IdentifierConfig } from './identifier-service';
import { EventQuery } from '../events/query/event-query';
import { EventValidator } from '../events/validation/event-validator';
import { createProjectionManager } from './storage-service';

/**
 * Create and initialize an EventStore instance
 * This is the ONE place where EventStore is instantiated
 *
 * @param envConfig - REQUIRED: Application environment configuration
 * @param config - Optional additional configuration (basePath can be provided here, or derived from envConfig)
 */
export async function createEventStore(
  envConfig: EnvironmentConfig,
  config?: Omit<EventStorageConfig, 'basePath' | 'dataDir'> & { basePath?: string }
): Promise<EventStore> {
  // Derive basePath from config or envConfig
  const basePath = config?.basePath || envConfig.services.filesystem?.path;
  if (!basePath) {
    throw new Error('basePath must be provided via config or envConfig.services.filesystem.path');
  }

  if (!envConfig.services?.backend?.publicURL) {
    throw new Error('Backend publicURL not found in configuration');
  }

  const baseUrl = envConfig.services.backend.publicURL;

  const identifierConfig: IdentifierConfig = {
    baseUrl,
  };

  // Create ProjectionManager (Layer 3)
  // Structure: <basePath>/projections/resources/...
  const projectionManager = createProjectionManager(basePath, {
    subNamespace: 'resources',
  });

  // Determine data directory for events (Layer 2)
  // Structure: <basePath>/events/...
  const dataDir = path.join(basePath, 'events');

  const eventStore = new EventStore(
    {
      ...config,
      basePath,
      dataDir,
      enableSharding: true,
      numShards: 65536,  // 4 hex digits
    },
    projectionManager,
    identifierConfig
  );

  return eventStore;
}

/**
 * Create EventQuery instance
 * Consumers use this for read operations
 */
export function createEventQuery(eventStore: EventStore): EventQuery {
  return new EventQuery(eventStore.log.storage);
}

/**
 * Create EventValidator instance
 * Consumers use this for validation operations
 */
export function createEventValidator(): EventValidator {
  return new EventValidator();
}
