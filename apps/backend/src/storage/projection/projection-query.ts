/**
 * ProjectionQuery - Layer 3 Query Operations
 *
 * Handles query operations for resource projections:
 * - Find by entity type
 * - Find by creator
 * - Get annotation count
 * - Filter by archived status
 * - Search operations
 *
 * Separated from storage to follow Single Responsibility Principle
 */

import type { ResourceState } from './projection-storage-v2';
import type { ProjectionStorage } from './projection-storage-v2';
import { getCreator } from '../../utils/resource-helpers';
import { resourceId as makeResourceId } from '@semiont/core';
import type { UserId } from '@semiont/core';

/**
 * ProjectionQuery provides query operations on projections
 */
export class ProjectionQuery {
  constructor(private storage: ProjectionStorage) {}

  /**
   * Find all projections with a specific entity type
   *
   * @param entityType - Entity type to filter by (e.g., 'Person')
   * @returns Array of matching projections
   */
  async findByEntityType(entityType: string): Promise<ResourceState[]> {
    const allIds = await this.storage.getAllResourceIds();
    const results: ResourceState[] = [];

    for (const id of allIds) {
      const projection = await this.storage.get(makeResourceId(id));
      if (projection && projection.resource.entityTypes?.includes(entityType)) {
        results.push(projection);
      }
    }

    return results;
  }

  /**
   * Find all projections created by a specific user
   *
   * @param userId - User DID to filter by
   * @returns Array of matching projections
   */
  async findByCreator(userId: UserId): Promise<ResourceState[]> {
    const allIds = await this.storage.getAllResourceIds();
    const results: ResourceState[] = [];

    for (const id of allIds) {
      const projection = await this.storage.get(makeResourceId(id));
      if (projection) {
        const creator = getCreator(projection.resource);
        if (creator?.['@id'] === userId) {
          results.push(projection);
        }
      }
    }

    return results;
  }

  /**
   * Find all archived projections
   *
   * @returns Array of archived projections
   */
  async findArchived(): Promise<ResourceState[]> {
    const allIds = await this.storage.getAllResourceIds();
    const results: ResourceState[] = [];

    for (const id of allIds) {
      const projection = await this.storage.get(makeResourceId(id));
      if (projection && projection.resource.archived) {
        results.push(projection);
      }
    }

    return results;
  }

  /**
   * Find all active (non-archived) projections
   *
   * @returns Array of active projections
   */
  async findActive(): Promise<ResourceState[]> {
    const allIds = await this.storage.getAllResourceIds();
    const results: ResourceState[] = [];

    for (const id of allIds) {
      const projection = await this.storage.get(makeResourceId(id));
      if (projection && !projection.resource.archived) {
        results.push(projection);
      }
    }

    return results;
  }

  /**
   * Get annotation count for a resource
   *
   * @param resourceId - Resource identifier
   * @returns Number of annotations or 0 if not found
   */
  async getAnnotationCount(resourceId: string): Promise<number> {
    const projection = await this.storage.get(makeResourceId(resourceId));
    return projection?.annotations.annotations.length || 0;
  }

  /**
   * Find projections with annotation count above threshold
   *
   * @param minCount - Minimum annotation count
   * @returns Array of projections with >= minCount annotations
   */
  async findByAnnotationCount(minCount: number): Promise<ResourceState[]> {
    const allIds = await this.storage.getAllResourceIds();
    const results: ResourceState[] = [];

    for (const id of allIds) {
      const projection = await this.storage.get(makeResourceId(id));
      if (projection && projection.annotations.annotations.length >= minCount) {
        results.push(projection);
      }
    }

    return results;
  }

  /**
   * Search projections by resource name (case-insensitive substring match)
   *
   * @param query - Search query string
   * @returns Array of matching projections
   */
  async searchByName(query: string): Promise<ResourceState[]> {
    const allIds = await this.storage.getAllResourceIds();
    const results: ResourceState[] = [];
    const lowerQuery = query.toLowerCase();

    for (const id of allIds) {
      const projection = await this.storage.get(makeResourceId(id));
      if (projection && projection.resource.name.toLowerCase().includes(lowerQuery)) {
        results.push(projection);
      }
    }

    return results;
  }

  /**
   * Get count of all projections
   *
   * @returns Total number of projections
   */
  async count(): Promise<number> {
    const ids = await this.storage.getAllResourceIds();
    return ids.length;
  }

  /**
   * Get count by entity type
   *
   * @param entityType - Entity type to count
   * @returns Number of projections with this entity type
   */
  async countByEntityType(entityType: string): Promise<number> {
    const results = await this.findByEntityType(entityType);
    return results.length;
  }

  /**
   * Check if any projections exist
   *
   * @returns True if at least one projection exists
   */
  async hasAny(): Promise<boolean> {
    const ids = await this.storage.getAllResourceIds();
    return ids.length > 0;
  }
}
