/**
 * Storage Service - Factory for Layer 3 Storage Managers
 *
 * Provides helper functions to create storage managers with correct configuration
 *
 * NO singletons - creates new instances
 * NO getFilesystemConfig calls - requires explicit basePath
 */

import { getFilesystemConfig } from '../config/environment-loader';
import { ProjectionManager, type ProjectionManagerConfig } from '../storage/projection/projection-manager';
import { ContentManager, type ContentManagerConfig } from '../storage/content/content-manager';

/**
 * Get base path from environment config
 * Centralized location for loading filesystem config
 */
export function getBasePath(): string {
  return getFilesystemConfig().path;
}

/**
 * Create ProjectionManager
 *
 * @param config - Optional configuration. If omitted, uses basePath from environment config
 * @returns New ProjectionManager instance
 */
export function createProjectionManager(config?: Partial<ProjectionManagerConfig>): ProjectionManager {
  const basePath = config?.basePath || getBasePath();
  return new ProjectionManager({ ...config, basePath });
}

/**
 * Create ContentManager
 *
 * @param config - Optional configuration. If omitted, uses basePath from environment config
 * @returns New ContentManager instance
 */
export function createContentManager(config?: Partial<ContentManagerConfig>): ContentManager {
  const basePath = config?.basePath || getBasePath();
  return new ContentManager({ ...config, basePath });
}
