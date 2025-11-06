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
import { resourceId as makeResourceId } from '@semiont/core';

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
  async save(resourceId: string, projection: ResourceState): Promise<void> {
    await this.storage.save(makeResourceId(resourceId), projection);
  }

  /**
   * Get projection from storage
   *
   * @param resourceId - Resource identifier
   * @returns Resource state or null if not found
   */
  async get(resourceId: string): Promise<ResourceState | null> {
    return this.storage.get(makeResourceId(resourceId));
  }

  /**
   * Delete projection from storage
   *
   * @param resourceId - Resource identifier
   */
  async delete(resourceId: string): Promise<void> {
    await this.storage.delete(makeResourceId(resourceId));
  }

  /**
   * Check if projection exists
   *
   * @param resourceId - Resource identifier
   * @returns True if projection exists
   */
  async exists(resourceId: string): Promise<boolean> {
    return this.storage.exists(makeResourceId(resourceId));
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
  async getAllResourceIds(): Promise<string[]> {
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

  // ============================================================
  // Backward Compatibility Methods (old ProjectionStorage interface)
  // ============================================================

  /**
   * @deprecated Use save() instead
   */
  async saveProjection(resourceId: string, projection: ResourceState): Promise<void> {
    return this.save(resourceId, projection);
  }

  /**
   * @deprecated Use get() instead
   */
  async getProjection(resourceId: string): Promise<ResourceState | null> {
    return this.get(resourceId);
  }

  /**
   * @deprecated Use delete() instead
   */
  async deleteProjection(resourceId: string): Promise<void> {
    return this.delete(resourceId);
  }

  /**
   * @deprecated Use exists() instead
   */
  async projectionExists(resourceId: string): Promise<boolean> {
    return this.exists(resourceId);
  }

  /**
   * @deprecated Use getAll() instead
   */
  async getAllProjections(): Promise<ResourceState[]> {
    return this.getAll();
  }
}
