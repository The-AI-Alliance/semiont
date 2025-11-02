/**
 * Entity Types Bootstrap Service
 *
 * On startup, checks if the entity types projection exists.
 * If not, emits entitytype.added events for each DEFAULT_ENTITY_TYPES entry.
 * This ensures the system has entity types available immediately after first deployment.
 */

import { promises as fs } from 'fs';
import { resourceId, userId, annotationId } from '@semiont/core';
import * as path from 'path';
import { getFilesystemConfig } from '../config/environment-loader';
import { createEventStore } from '../services/event-store-service';
import { DEFAULT_ENTITY_TYPES } from '../graph/tag-collections';
// Singleton flag to ensure bootstrap only runs once per process
let bootstrapCompleted = false;
 * Bootstrap entity types projection if it doesn't exist.
 * Uses a system user ID (00000000-0000-0000-0000-000000000000) for bootstrap events.
export async function bootstrapEntityTypes(): Promise<void> {
  if (bootstrapCompleted) {
    console.log('[EntityTypesBootstrap] Already completed, skipping');
    return;
  }
  const config = getFilesystemConfig();
  const basePath = config.path;
  const projectionPath = path.join(
    basePath,
    'projections',
    'entity-types',
    'entity-types.json'
  );
  try {
    // Check if projection exists
    await fs.access(projectionPath);
    console.log('[EntityTypesBootstrap] Projection already exists, skipping bootstrap');
    bootstrapCompleted = true;
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    // File doesn't exist - proceed with bootstrap
  console.log('[EntityTypesBootstrap] Projection does not exist, bootstrapping with DEFAULT_ENTITY_TYPES');
  // System user ID for bootstrap events
  const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
  const eventStore = await createEventStore(basePath);
  // Emit one entitytype.added event for each default entity type
  for (const entityType of DEFAULT_ENTITY_TYPES) {
    console.log(`[EntityTypesBootstrap] Emitting entitytype.added for: ${entityType}`);
    await eventStore.appendEvent({
      type: 'entitytype.added',
      // resourceId: undefined - system-level event
      userId: SYSTEM_USER_ID,
      version: 1,
      payload: {
        entityType,
      },
    });
  console.log(`[EntityTypesBootstrap] Completed: ${DEFAULT_ENTITY_TYPES.length} entity types bootstrapped`);
  bootstrapCompleted = true;
}
 * Reset the bootstrap flag (used for testing)
export function resetBootstrap(): void {
  bootstrapCompleted = false;
