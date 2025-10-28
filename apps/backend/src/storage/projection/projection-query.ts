/**
 * ProjectionQuery - Layer 3 Query Operations
 *
 * Handles query operations for document projections:
 * - Find by entity type
 * - Find by creator
 * - Get annotation count
 * - Filter by archived status
 * - Search operations
 *
 * Separated from storage to follow Single Responsibility Principle
 */

import type { DocumentState } from './projection-storage-v2';
import type { ProjectionStorage } from './projection-storage-v2';
import { getCreator } from '../../utils/resource-helpers';

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
  async findByEntityType(entityType: string): Promise<DocumentState[]> {
    const allIds = await this.storage.getAllDocumentIds();
    const results: DocumentState[] = [];

    for (const id of allIds) {
      const projection = await this.storage.get(id);
      if (projection && projection.document.entityTypes?.includes(entityType)) {
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
  async findByCreator(userId: string): Promise<DocumentState[]> {
    const allIds = await this.storage.getAllDocumentIds();
    const results: DocumentState[] = [];

    for (const id of allIds) {
      const projection = await this.storage.get(id);
      if (projection) {
        const creator = getCreator(projection.document);
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
  async findArchived(): Promise<DocumentState[]> {
    const allIds = await this.storage.getAllDocumentIds();
    const results: DocumentState[] = [];

    for (const id of allIds) {
      const projection = await this.storage.get(id);
      if (projection && projection.document.archived) {
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
  async findActive(): Promise<DocumentState[]> {
    const allIds = await this.storage.getAllDocumentIds();
    const results: DocumentState[] = [];

    for (const id of allIds) {
      const projection = await this.storage.get(id);
      if (projection && !projection.document.archived) {
        results.push(projection);
      }
    }

    return results;
  }

  /**
   * Get annotation count for a document
   *
   * @param documentId - Document identifier
   * @returns Number of annotations or 0 if not found
   */
  async getAnnotationCount(documentId: string): Promise<number> {
    const projection = await this.storage.get(documentId);
    return projection?.annotations.annotations.length || 0;
  }

  /**
   * Find projections with annotation count above threshold
   *
   * @param minCount - Minimum annotation count
   * @returns Array of projections with >= minCount annotations
   */
  async findByAnnotationCount(minCount: number): Promise<DocumentState[]> {
    const allIds = await this.storage.getAllDocumentIds();
    const results: DocumentState[] = [];

    for (const id of allIds) {
      const projection = await this.storage.get(id);
      if (projection && projection.annotations.annotations.length >= minCount) {
        results.push(projection);
      }
    }

    return results;
  }

  /**
   * Search projections by document name (case-insensitive substring match)
   *
   * @param query - Search query string
   * @returns Array of matching projections
   */
  async searchByName(query: string): Promise<DocumentState[]> {
    const allIds = await this.storage.getAllDocumentIds();
    const results: DocumentState[] = [];
    const lowerQuery = query.toLowerCase();

    for (const id of allIds) {
      const projection = await this.storage.get(id);
      if (projection && projection.document.name.toLowerCase().includes(lowerQuery)) {
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
    const ids = await this.storage.getAllDocumentIds();
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
    const ids = await this.storage.getAllDocumentIds();
    return ids.length > 0;
  }
}
