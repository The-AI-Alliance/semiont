/**
 * PathBuilder - Centralized Path Management for ViewStorage
 *
 * Builds sharded paths for all storage types (views, content, etc.)
 * Single source of truth for path construction and sharding strategy
 *
 * Replaces duplicate path logic in FilesystemProjectionStorage and FilesystemStorage
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { getShardPath } from '../shard-utils';
import { type ResourceId, resourceId as makeResourceId } from '@semiont/core';

export interface PathBuilderConfig {
  basePath: string;
  namespace: string;       // 'projections', 'resources', etc.
  subNamespace?: string;   // 'resources', '__system__', etc.
}

/**
 * PathBuilder constructs sharded file paths for storage
 *
 * Example paths:
 * - Projections: basePath/projections/resources/ab/cd/doc-123.json
 * - System projections: basePath/projections/__system__/entity-types.json
 * - Content: basePath/resources/ab/cd/doc-123.dat
 */
export class PathBuilder {
  private basePath: string;
  private namespace: string;
  private subNamespace?: string;

  constructor(config: PathBuilderConfig) {
    this.basePath = config.basePath;
    this.namespace = config.namespace;
    this.subNamespace = config.subNamespace;
  }

  /**
   * Build sharded path for a resource
   *
   * @param resourceId - Resource identifier
   * @param extension - File extension (e.g., '.json', '.dat')
   * @returns Full file path with sharding
   */
  buildPath(resourceId: ResourceId, extension: string): string {
    const [ab, cd] = getShardPath(resourceId);

    const parts = [this.basePath, this.namespace];
    if (this.subNamespace) {
      parts.push(this.subNamespace);
    }
    parts.push(ab, cd, `${resourceId}${extension}`);

    return path.join(...parts);
  }

  /**
   * Build path for system-level files (no sharding)
   *
   * @param filename - Filename (e.g., 'entity-types.json')
   * @returns Full file path without sharding
   */
  buildSystemPath(filename: string): string {
    const parts = [this.basePath, this.namespace];
    if (this.subNamespace) {
      parts.push(this.subNamespace);
    }
    parts.push(filename);

    return path.join(...parts);
  }

  /**
   * Ensure directory exists for a file path
   *
   * @param filePath - Full file path
   */
  async ensureDirectory(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * Get root path for this builder's namespace
   */
  getRootPath(): string {
    const parts = [this.basePath, this.namespace];
    if (this.subNamespace) {
      parts.push(this.subNamespace);
    }
    return path.join(...parts);
  }

  /**
   * Scan for all resource IDs in storage
   *
   * @param extension - File extension to filter by
   * @returns Array of resource IDs
   */
  async scanForResources(extension: string): Promise<ResourceId[]> {
    const resourceIds: ResourceId[] = [];
    const rootPath = this.getRootPath();

    try {
      const walkDir = async (dir: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith(extension)) {
            // Extract resource ID from filename
            const id = entry.name.slice(0, -extension.length);
            resourceIds.push(makeResourceId(id));
          }
        }
      };

      await walkDir(rootPath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Root path doesn't exist yet
        return [];
      }
      throw error;
    }

    return resourceIds;
  }

  /**
   * Check if root directory exists
   */
  async exists(): Promise<boolean> {
    const rootPath = this.getRootPath();
    try {
      await fs.access(rootPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create root directory
   */
  async initialize(): Promise<void> {
    const rootPath = this.getRootPath();
    await fs.mkdir(rootPath, { recursive: true });
  }
}
