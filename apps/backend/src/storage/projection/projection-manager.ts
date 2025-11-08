/**
 * ProjectionManager - Layer 3 Orchestration
 *
 * Coordinates projection operations across specialized modules:
 * - ProjectionStorage: File I/O operations
 * - ProjectionQuery: Query operations
 *
 * Similar to EventStore pattern: orchestration only, delegates to modules
 *
 * NO caching (per requirements)
 * NO singleton pattern
 * Direct instantiation
 *
 * @see docs/EVENT-STORE.md for comparison with Layer 2 architecture
 */

import type { ResourceState } from './projection-storage-v2';
import { ProjectionStorage, type ProjectionStorageConfig } from './projection-storage-v2';
import { ProjectionQuery } from './projection-query';
import type { ResourceId } from '@semiont/core';

export type { ResourceState } from './projection-storage-v2';
export type { ProjectionStorageConfig as ProjectionManagerConfig };

/**
 * ProjectionManager coordinates Layer 3 projection operations
 *
 * Delegates to specialized modules for focused functionality
 * NO state - just coordination between modules
 */
export class ProjectionManager {
  readonly storage: ProjectionStorage;
  readonly query: ProjectionQuery;

  constructor(config: ProjectionStorageConfig) {
    this.storage = new ProjectionStorage(config);
    this.query = new ProjectionQuery(this.storage);
  }

  /**
   * Save projection to storage
   *
   * @param resourceId - Resource identifier
   * @param projection - Complete resource state
   */
  async save(resourceId: ResourceId, projection: ResourceState): Promise<void> {
    await this.storage.save(resourceId, projection);
  }

  /**
   * Get projection from storage
   *
   * @param resourceId - Resource identifier
   * @returns Resource state or null if not found
   */
  async get(resourceId: ResourceId): Promise<ResourceState | null> {
    return this.storage.get(resourceId);
  }

  /**
   * Delete projection from storage
   *
   * @param resourceId - Resource identifier
   */
  async delete(resourceId: ResourceId): Promise<void> {
    await this.storage.delete(resourceId);
  }

  /**
   * Check if projection exists
   *
   * @param resourceId - Resource identifier
   * @returns True if projection exists
   */
  async exists(resourceId: ResourceId): Promise<boolean> {
    return this.storage.exists(resourceId);
  }

  /**
   * Get all projections (expensive - loads all from disk)
   *
   * @returns Array of all resource states
   */
  async getAll(): Promise<ResourceState[]> {
    return this.storage.getAll();
  }

  /**
   * Get all resource IDs
   *
   * @returns Array of resource IDs
   */
  async getAllResourceIds(): Promise<ResourceId[]> {
    return this.storage.getAllResourceIds();
  }

  /**
   * Save system projection (no sharding)
   *
   * @param filename - Filename (e.g., 'entity-types.json')
   * @param data - Data to save
   */
  async saveSystem(filename: string, data: any): Promise<void> {
    await this.storage.saveSystem(filename, data);
  }

  /**
   * Get system projection (no sharding)
   *
   * @param filename - Filename (e.g., 'entity-types.json')
   * @returns Data or null if not found
   */
  async getSystem<T = any>(filename: string): Promise<T | null> {
    return this.storage.getSystem<T>(filename);
  }
}
