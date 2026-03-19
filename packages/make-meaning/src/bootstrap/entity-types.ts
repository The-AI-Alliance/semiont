/**
 * Entity Types Bootstrap Service
 *
 * On startup, checks if the entity types projection exists.
 * If not, emits mark:add-entity-type for each DEFAULT_ENTITY_TYPES entry.
 * This ensures the system has entity types available immediately after first deployment.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';
import { EventBus, userId, type Logger } from '@semiont/core';
import type { MakeMeaningConfig } from '../config';
import { firstValueFrom, race, timer } from 'rxjs';
import { map, take } from 'rxjs/operators';

// Singleton flag to ensure bootstrap only runs once per process
let bootstrapCompleted = false;

/**
 * Bootstrap entity types projection if it doesn't exist.
 * Uses a system user ID (00000000-0000-0000-0000-000000000000) for bootstrap events.
 */
export async function bootstrapEntityTypes(eventBus: EventBus, config: MakeMeaningConfig, logger?: Logger): Promise<void> {
  if (bootstrapCompleted) {
    logger?.debug('Entity types bootstrap already completed, skipping');
    return;
  }

  const projectRoot = config._metadata?.projectRoot;
  if (!projectRoot) {
    throw new Error('config._metadata.projectRoot is required for entity types bootstrap');
  }
  const basePath = path.join(projectRoot, '.semiont', 'data');

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
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    // File doesn't exist - proceed with bootstrap
    logger?.info('Entity types projection does not exist, bootstrapping with DEFAULT_ENTITY_TYPES');
  }

  const SYSTEM_USER_ID = userId('00000000-0000-0000-0000-000000000000');

  // Emit mark:add-entity-type for each default entity type, awaiting confirmation
  for (const entityType of DEFAULT_ENTITY_TYPES) {
    logger?.debug('Adding entity type via EventBus', { entityType });

    const result$ = race(
      eventBus.get('mark:entity-type-added').pipe(take(1), map(() => ({ ok: true as const }))),
      eventBus.get('mark:entity-type-add-failed').pipe(take(1), map((f) => ({ ok: false as const, error: f.error }))),
      timer(10_000).pipe(map(() => ({ ok: false as const, error: new Error(`Timeout adding entity type: ${entityType}`) }))),
    );

    eventBus.get('mark:add-entity-type').next({ tag: entityType, userId: SYSTEM_USER_ID });

    const outcome = await firstValueFrom(result$);
    if (!outcome.ok) {
      throw outcome.error;
    }
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
