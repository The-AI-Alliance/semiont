/**
 * Storage Service - Factory for Layer 3 Storage Managers
 *
 * Provides helper functions to create storage managers with correct configuration
 *
 * NO singletons - creates new instances
 * NO getFilesystemConfig calls - requires EXPLICIT basePath from caller
 * NO fallbacks - basePath is REQUIRED
 */

import { ProjectionManager, type ProjectionManagerConfig } from '../storage/projection/projection-manager';

/**
 * Create ProjectionManager
 *
 * @param basePath - REQUIRED: Base filesystem path for projections
 * @param config - Optional additional configuration
 * @returns New ProjectionManager instance
 */
export function createProjectionManager(
  basePath: string,
  config?: Omit<ProjectionManagerConfig, 'basePath'>
): ProjectionManager {
  return new ProjectionManager({ ...config, basePath });
}
