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

import type { DocumentState } from './projection-storage-v2';
import { ProjectionStorage, type ProjectionStorageConfig } from './projection-storage-v2';
import { ProjectionQuery } from './projection-query';

export type { DocumentState } from './projection-storage-v2';
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
   * @param documentId - Document identifier
   * @param projection - Complete document state
   */
  async save(documentId: string, projection: DocumentState): Promise<void> {
    await this.storage.save(documentId, projection);
  }

  /**
   * Get projection from storage
   *
   * @param documentId - Document identifier
   * @returns Document state or null if not found
   */
  async get(documentId: string): Promise<DocumentState | null> {
    return this.storage.get(documentId);
  }

  /**
   * Delete projection from storage
   *
   * @param documentId - Document identifier
   */
  async delete(documentId: string): Promise<void> {
    await this.storage.delete(documentId);
  }

  /**
   * Check if projection exists
   *
   * @param documentId - Document identifier
   * @returns True if projection exists
   */
  async exists(documentId: string): Promise<boolean> {
    return this.storage.exists(documentId);
  }

  /**
   * Get all projections (expensive - loads all from disk)
   *
   * @returns Array of all document states
   */
  async getAll(): Promise<DocumentState[]> {
    return this.storage.getAll();
  }

  /**
   * Get all document IDs
   *
   * @returns Array of document IDs
   */
  async getAllDocumentIds(): Promise<string[]> {
    return this.storage.getAllDocumentIds();
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
  async saveProjection(documentId: string, projection: DocumentState): Promise<void> {
    return this.save(documentId, projection);
  }

  /**
   * @deprecated Use get() instead
   */
  async getProjection(documentId: string): Promise<DocumentState | null> {
    return this.get(documentId);
  }

  /**
   * @deprecated Use delete() instead
   */
  async deleteProjection(documentId: string): Promise<void> {
    return this.delete(documentId);
  }

  /**
   * @deprecated Use exists() instead
   */
  async projectionExists(documentId: string): Promise<boolean> {
    return this.exists(documentId);
  }

  /**
   * @deprecated Use getAll() instead
   */
  async getAllProjections(): Promise<DocumentState[]> {
    return this.getAll();
  }
}
