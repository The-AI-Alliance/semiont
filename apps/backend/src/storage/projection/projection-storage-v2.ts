/**
 * ProjectionStorage - Layer 3 Projection File I/O
 *
 * Handles ONLY file operations for document projections:
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
import type { DocumentAnnotations } from '@semiont/core';
import { PathBuilder } from '../shared/path-builder';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

// Complete state for a document in Layer 3 (metadata + annotations)
export interface DocumentState {
  document: ResourceDescriptor;
  annotations: DocumentAnnotations;
}

export interface ProjectionStorageConfig {
  basePath: string;
  subNamespace?: string;  // 'documents', '__system__', etc.
}

/**
 * ProjectionStorage handles file I/O for document projections
 *
 * Storage structure:
 * basePath/projections/{subNamespace}/ab/cd/doc-123.json
 *
 * Example:
 * - Document: /data/projections/documents/00/a3/doc-abc123.json
 * - System: /data/projections/__system__/entity-types.json
 */
export class ProjectionStorage {
  private pathBuilder: PathBuilder;

  constructor(config: ProjectionStorageConfig) {
    this.pathBuilder = new PathBuilder({
      basePath: config.basePath,
      namespace: 'projections',
      subNamespace: config.subNamespace || 'documents',
    });
  }

  /**
   * Save projection to disk
   *
   * @param documentId - Document identifier
   * @param projection - Complete document state (metadata + annotations)
   */
  async save(documentId: string, projection: DocumentState): Promise<void> {
    const filePath = this.pathBuilder.buildPath(documentId, '.json');
    await this.pathBuilder.ensureDirectory(filePath);

    // Write with pretty formatting for human readability
    await fs.writeFile(filePath, JSON.stringify(projection, null, 2), 'utf-8');
  }

  /**
   * Load projection from disk
   *
   * @param documentId - Document identifier
   * @returns Document state or null if not found
   */
  async get(documentId: string): Promise<DocumentState | null> {
    const filePath = this.pathBuilder.buildPath(documentId, '.json');

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as DocumentState;
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
   * @param documentId - Document identifier
   */
  async delete(documentId: string): Promise<void> {
    const filePath = this.pathBuilder.buildPath(documentId, '.json');

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
   * @param documentId - Document identifier
   * @returns True if projection file exists
   */
  async exists(documentId: string): Promise<boolean> {
    const filePath = this.pathBuilder.buildPath(documentId, '.json');

    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all document IDs that have projections
   *
   * @returns Array of document IDs
   */
  async getAllDocumentIds(): Promise<string[]> {
    return this.pathBuilder.scanForDocuments('.json');
  }

  /**
   * Get all projections (expensive - loads all from disk)
   *
   * @returns Array of all document states
   */
  async getAll(): Promise<DocumentState[]> {
    const documentIds = await this.getAllDocumentIds();
    const projections: DocumentState[] = [];

    for (const id of documentIds) {
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
