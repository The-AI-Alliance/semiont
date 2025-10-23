/**
 * Storage Service - Factory for Layer 3 Storage Managers
 *
 * Provides helper functions to create storage managers with correct configuration
 *
 * NO singletons - creates new instances
 * Uses environment configuration by default
 */

import { getFilesystemConfig } from '../config/environment-loader';
import { ProjectionManager, type ProjectionManagerConfig } from '../storage/projection/projection-manager';
import { ContentManager, type ContentManagerConfig } from '../storage/content/content-manager';

/**
 * Create ProjectionManager with environment configuration
 *
 * @param config - Optional configuration override
 * @returns New ProjectionManager instance
 */
export function createProjectionManager(config?: Partial<ProjectionManagerConfig>): ProjectionManager {
  const fsConfig = getFilesystemConfig();

  const fullConfig: ProjectionManagerConfig = {
    basePath: config?.basePath || fsConfig.path,
    subNamespace: config?.subNamespace || 'documents',
  };

  return new ProjectionManager(fullConfig);
}

/**
 * Create ContentManager with environment configuration
 *
 * @param config - Optional configuration override
 * @returns New ContentManager instance
 */
export function createContentManager(config?: Partial<ContentManagerConfig>): ContentManager {
  const fsConfig = getFilesystemConfig();

  const fullConfig: ContentManagerConfig = {
    basePath: config?.basePath || fsConfig.path,
  };

  return new ContentManager(fullConfig);
}
