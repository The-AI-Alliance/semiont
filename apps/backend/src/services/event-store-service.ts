/**
 * Event Store Service - Backend Configuration Wrapper
 *
 * Thin wrapper around @semiont/event-sourcing's createEventStore factory.
 * Extracts configuration from EnvironmentConfig and resolves paths.
 */

import * as path from 'path';
import type { EnvironmentConfig } from '@semiont/core';
import { createEventStore as createEventStoreCore, EventStore, EventQuery, EventValidator } from '@semiont/event-sourcing';
import type { EventStorageConfig } from '@semiont/event-sourcing';

/**
 * Create EventStore from backend EnvironmentConfig
 * Handles path resolution and config extraction
 *
 * @param envConfig - Backend environment configuration
 * @param config - Optional additional storage configuration
 * @returns Configured EventStore instance
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

  // Extract baseUrl from backend config
  if (!envConfig.services?.backend?.publicURL) {
    throw new Error('Backend publicURL not found in configuration');
  }
  const baseUrl = envConfig.services.backend.publicURL;

  // Delegate to event-sourcing package
  return createEventStoreCore(basePath, baseUrl, config);
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
