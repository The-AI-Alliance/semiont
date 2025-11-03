/**
 * Event Store Service - Dependency Injection
 *
 * Single initialization point for EventStore and all its dependencies.
 * No singleton pattern - just a simple factory function.
 * Uses @semiont/core config loading to get backend.publicURL
 */

import * as path from 'path';
import { loadEnvironmentConfig, findProjectRoot } from '@semiont/core';
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
 * @param basePath - REQUIRED: Base filesystem path for all storage
 * @param config - Optional additional configuration
 */
export async function createEventStore(
  basePath: string,
  config?: Omit<EventStorageConfig, 'basePath' | 'dataDir'>
): Promise<EventStore> {
  // Load environment configuration to get backend.publicURL
  const environment = process.env.SEMIONT_ENV;
  if (!environment) {
    throw new Error('SEMIONT_ENV environment variable is required');
  }

  const projectRoot = findProjectRoot();
  const envConfig = await loadEnvironmentConfig(projectRoot, environment);

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
  return new EventQuery(eventStore.storage);
}

/**
 * Create EventValidator instance
 * Consumers use this for validation operations
 */
export function createEventValidator(): EventValidator {
  return new EventValidator();
}
