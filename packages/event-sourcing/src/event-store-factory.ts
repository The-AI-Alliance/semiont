/**
 * Event Store Factory
 *
 * Factory function for creating EventStore instances with standard configuration.
 * This is the canonical way to instantiate an EventStore.
 */

import * as path from 'path';
import type { EventBus as CoreEventBus, Logger } from '@semiont/core';
import { EventStore } from './event-store';
import { FilesystemViewStorage } from './storage/view-storage';
import type { EventStorageConfig } from './storage/event-storage';
import type { IdentifierConfig } from './types';

/**
 * Create and initialize an EventStore instance
 *
 * @param basePath - Absolute path to the data directory (must be resolved by caller)
 * @param baseUrl - Base URL for generating identifiers (e.g., "http://localhost:8080")
 * @param config - Optional additional storage configuration
 * @param eventBus - Optional @semiont/core EventBus for publishing domain events
 * @param logger - Optional logger for structured logging
 * @returns Configured EventStore instance ready for use
 *
 * @example
 * ```typescript
 * const eventStore = createEventStore(
 *   '/absolute/path/to/data',
 *   'http://localhost:8080'
 * );
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
  basePath: string,
  baseUrl: string,
  config?: Partial<EventStorageConfig>,
  eventBus?: CoreEventBus,
  logger?: Logger
): EventStore {
  if (!basePath) {
    throw new Error('basePath is required to create EventStore');
  }
  if (!baseUrl) {
    throw new Error('baseUrl is required to create EventStore');
  }
  if (!path.isAbsolute(basePath)) {
    throw new Error('basePath must be an absolute path (use path.resolve() to convert relative paths)');
  }

  const identifierConfig: IdentifierConfig = {
    baseUrl,
  };

  // Create ViewStorage for materialized views
  // Structure: <basePath>/projections/resources/...
  const viewStorage = new FilesystemViewStorage(basePath, undefined, logger?.child({ component: 'view-storage' }));

  // Determine data directory for events
  // Structure: <basePath>/events/...
  const dataDir = path.join(basePath, 'events');

  const eventStore = new EventStore(
    {
      ...config,
      basePath,
      dataDir,
      enableSharding: true,
      numShards: 65536, // 4 hex digits (0000-ffff)
    },
    viewStorage,
    identifierConfig,
    eventBus,
    logger
  );

  return eventStore;
}
