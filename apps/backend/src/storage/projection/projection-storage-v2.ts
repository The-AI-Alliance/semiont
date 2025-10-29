/**
 * ProjectionStorage - Layer 3 Projection File I/O
 *
 * Handles ONLY file operations for resource projections:
 * - Save projection to disk (JSON format)
 * - Load projection from disk
 * - Delete projection
 * - Check existence
 * - Scan all projections
 *
 * NO caching - pure I/O operations
 * NO singleton pattern - direct instantiation
 * Uses PathBuilder for sharding and path management
 *
 * @see docs/EVENT-STORE.md for Layer 2 → Layer 3 flow
 */

import { promises as fs } from 'fs';
import type { components } from '@semiont/api-client';
import type { ResourceAnnotations } from '@semiont/core';
import { PathBuilder } from '../shared/path-builder';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

// Complete state for a resource in Layer 3 (metadata + annotations)
export interface ResourceState {
  resource: ResourceDescriptor;
  annotations: ResourceAnnotations;
}

export interface ProjectionStorageConfig {
  basePath: string;
  subNamespace?: string;  // 'resources', '__system__', etc.
}

/**
 * ProjectionStorage handles file I/O for resource projections
 *
 * Storage structure:
 * basePath/projections/{subNamespace}/ab/cd/doc-123.json
 *
 * Example:
 * - Resource: /data/projections/resources/00/a3/doc-abc123.json
 * - System: /data/projections/__system__/entity-types.json
 */
export class ProjectionStorage {
  private pathBuilder: PathBuilder;

  constructor(config: ProjectionStorageConfig) {
    this.pathBuilder = new PathBuilder({
      basePath: config.basePath,
      namespace: 'projections',
      subNamespace: config.subNamespace || 'resources',
    });
  }

  /**
   * Save projection to disk
   *
   * @param resourceId - Resource identifier
   * @param projection - Complete resource state (metadata + annotations)
   */
  async save(resourceId: string, projection: ResourceState): Promise<void> {
    const filePath = this.pathBuilder.buildPath(resourceId, '.json');
    await this.pathBuilder.ensureDirectory(filePath);

    // Write with pretty formatting for human readability
    await fs.writeFile(filePath, JSON.stringify(projection, null, 2), 'utf-8');
  }

  /**
   * Load projection from disk
   *
   * @param resourceId - Resource identifier
   * @returns Resource state or null if not found
   */
  async get(resourceId: string): Promise<ResourceState | null> {
    const filePath = this.pathBuilder.buildPath(resourceId, '.json');

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as ResourceState;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Delete projection from disk
   *
   * @param resourceId - Resource identifier
   */
  async delete(resourceId: string): Promise<void> {
    const filePath = this.pathBuilder.buildPath(resourceId, '.json');

    try {
      await fs.unlink(filePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // Ignore if file doesn't exist
    }
  }

  /**
   * Check if projection exists
   *
   * @param resourceId - Resource identifier
   * @returns True if projection file exists
   */
  async exists(resourceId: string): Promise<boolean> {
    const filePath = this.pathBuilder.buildPath(resourceId, '.json');

    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all resource IDs that have projections
   *
   * @returns Array of resource IDs
   */
  async getAllResourceIds(): Promise<string[]> {
    return this.pathBuilder.scanForResources('.json');
  }

  /**
   * Get all projections (expensive - loads all from disk)
   *
   * @returns Array of all resource states
   */
  async getAll(): Promise<ResourceState[]> {
    const resourceIds = await this.getAllResourceIds();
    const projections: ResourceState[] = [];

    for (const id of resourceIds) {
      try {
        const projection = await this.get(id);
        if (projection) {
          projections.push(projection);
        }
      } catch (error) {
        console.error(`[ProjectionStorage] Failed to load projection ${id}:`, error);
        // Skip invalid projections
      }
    }

    return projections;
  }

  /**
   * Save system projection (no sharding)
   *
   * @param filename - Filename (e.g., 'entity-types.json')
   * @param data - Data to save
   */
  async saveSystem(filename: string, data: any): Promise<void> {
    const filePath = this.pathBuilder.buildSystemPath(filename);
    await this.pathBuilder.ensureDirectory(filePath);

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Load system projection (no sharding)
   *
   * @param filename - Filename (e.g., 'entity-types.json')
   * @returns Data or null if not found
   */
  async getSystem<T = any>(filename: string): Promise<T | null> {
    const filePath = this.pathBuilder.buildSystemPath(filename);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}
