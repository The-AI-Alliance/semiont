/**
 * Event Store Service - Dependency Injection
 *
 * Single initialization point for EventStore and all its dependencies.
 * No singleton pattern - just a simple factory function.
 */

import * as path from 'path';
import type { EnvironmentConfig } from '@semiont/core';
import { EventStore, EventQuery, EventValidator, FilesystemViewStorage } from '@semiont/event-sourcing';
import type { EventStorageConfig, IdentifierConfig } from '@semiont/event-sourcing';

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
  const configuredPath = config?.basePath || envConfig.services.filesystem?.path;
  if (!configuredPath) {
    throw new Error('basePath must be provided via config or envConfig.services.filesystem.path');
  }

  // Resolve basePath against project root if relative
  const projectRoot = envConfig._metadata?.projectRoot;
  let basePath: string;
  if (path.isAbsolute(configuredPath)) {
    basePath = configuredPath;
  } else if (projectRoot) {
    basePath = path.resolve(projectRoot, configuredPath);
  } else {
    // Fallback to resolving against cwd (backward compat)
    basePath = path.resolve(configuredPath);
  }

  if (!envConfig.services?.backend?.publicURL) {
    throw new Error('Backend publicURL not found in configuration');
  }

  const baseUrl = envConfig.services.backend.publicURL;

  const identifierConfig: IdentifierConfig = {
    baseUrl,
  };

  // Create ViewStorage for materialized views
  // Structure: <basePath>/projections/resources/...
  // basePath is already resolved, pass projectRoot for safety
  const viewStorage = new FilesystemViewStorage(basePath, projectRoot);

  // Determine data directory for events
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
    viewStorage,
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
