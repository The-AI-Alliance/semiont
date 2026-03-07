/**
 * Entity Types Bootstrap Service
 *
 * On startup, checks if the entity types projection exists.
 * If not, emits entitytype.added events for each DEFAULT_ENTITY_TYPES entry.
 * This ensures the system has entity types available immediately after first deployment.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { EventStore } from '@semiont/event-sourcing';
import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';
import { userId, type EnvironmentConfig, type Logger } from '@semiont/core';

// Singleton flag to ensure bootstrap only runs once per process
let bootstrapCompleted = false;

/**
 * Bootstrap entity types projection if it doesn't exist.
 * Uses a system user ID (00000000-0000-0000-0000-000000000000) for bootstrap events.
 */
export async function bootstrapEntityTypes(eventStore: EventStore, config: EnvironmentConfig, logger?: Logger): Promise<void> {
  if (bootstrapCompleted) {
    logger?.debug('Entity types bootstrap already completed, skipping');
    return;
  }

  // Resolve basePath against project root if relative
  const configuredPath = config.services.filesystem!.path;
  const projectRoot = config._metadata?.projectRoot;
  let basePath: string;
  if (path.isAbsolute(configuredPath)) {
    basePath = configuredPath;
  } else if (projectRoot) {
    basePath = path.resolve(projectRoot, configuredPath);
  } else {
    basePath = path.resolve(configuredPath);
  }

  const projectionPath = path.join(
    basePath,
    'projections',
    '__system__',
    'entitytypes.json'
  );

  try {
    // Check if projection exists
    await fs.access(projectionPath);
    logger?.info('Entity types projection already exists, skipping bootstrap');
    bootstrapCompleted = true;
    return;
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    // File doesn't exist - proceed with bootstrap
    logger?.info('Entity types projection does not exist, bootstrapping with DEFAULT_ENTITY_TYPES');
  }

  // System user ID for bootstrap events
  const SYSTEM_USER_ID = userId('00000000-0000-0000-0000-000000000000');

  // Emit one entitytype.added event for each default entity type
  for (const entityType of DEFAULT_ENTITY_TYPES) {
    logger?.debug('Emitting entitytype.added event', { entityType });
    await eventStore.appendEvent({
      type: 'entitytype.added',
      // resourceId: undefined - system-level event
      userId: SYSTEM_USER_ID,
      version: 1,
      payload: {
        entityType,
      },
    });
  }

  logger?.info('Entity types bootstrap completed', { count: DEFAULT_ENTITY_TYPES.length });
  bootstrapCompleted = true;
}

/**
 * Reset the bootstrap flag (used for testing)
 */
export function resetBootstrap(): void {
  bootstrapCompleted = false;
}
