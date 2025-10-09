/**
 * Layer 3: Projection Storage
 *
 * Stores materialized views of document state and annotations
 * Built from Layer 2 event streams, can be rebuilt at any time
 *
 * Stores both Document metadata and DocumentAnnotations, but keeps them logically separate
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { getShardPath } from './shard-utils';
import { getFilesystemConfig } from '../config/environment-loader';
import type { Document, DocumentAnnotations } from '@semiont/core-types';

// Complete state for a document in Layer 3 (metadata + annotations)
export interface DocumentState {
  document: Document;
  annotations: DocumentAnnotations;
}

export interface ProjectionStorage {
  saveProjection(documentId: string, projection: DocumentState): Promise<void>;
  getProjection(documentId: string): Promise<DocumentState | null>;
  deleteProjection(documentId: string): Promise<void>;
  projectionExists(documentId: string): Promise<boolean>;
  getAllProjections(): Promise<DocumentState[]>;
}

export class FilesystemProjectionStorage implements ProjectionStorage {
  private basePath: string;

  constructor(basePath?: string) {
    if (basePath) {
      this.basePath = basePath;
    } else {
      const config = getFilesystemConfig();
      this.basePath = config.path;
    }
  }

  private getProjectionPath(documentId: string): string {
    // Use 4-hex Jump Consistent Hash sharding (65,536 shards)
    const [ab, cd] = getShardPath(documentId);
    return path.join(this.basePath, 'annotations', ab, cd, `${documentId}.json`);
  }

  async saveProjection(documentId: string, projection: DocumentState): Promise<void> {
    const projPath = this.getProjectionPath(documentId);
    const projDir = path.dirname(projPath);

    // Ensure shard directory exists
    await fs.mkdir(projDir, { recursive: true });

    // Write projection to file
    await fs.writeFile(projPath, JSON.stringify(projection, null, 2), 'utf-8');
  }

  async getProjection(documentId: string): Promise<DocumentState | null> {
    const projPath = this.getProjectionPath(documentId);

    try {
      const content = await fs.readFile(projPath, 'utf-8');
      return JSON.parse(content) as DocumentState;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async deleteProjection(documentId: string): Promise<void> {
    const projPath = this.getProjectionPath(documentId);

    try {
      await fs.unlink(projPath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // Ignore if file doesn't exist
    }
  }

  async projectionExists(documentId: string): Promise<boolean> {
    const projPath = this.getProjectionPath(documentId);

    try {
      await fs.access(projPath);
      return true;
    } catch {
      return false;
    }
  }

  async getAllProjections(): Promise<DocumentState[]> {
    const projections: DocumentState[] = [];
    const annotationsPath = path.join(this.basePath, 'annotations');

    try {
      // Recursively walk through all shard directories
      const walkDir = async (dir: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.json')) {
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              const projection = JSON.parse(content) as DocumentState;
              projections.push(projection);
            } catch (error) {
              console.error(`[ProjectionStorage] Failed to read projection ${fullPath}:`, error);
              // Skip invalid projection files
            }
          }
        }
      };

      await walkDir(annotationsPath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Annotations directory doesn't exist yet
        return [];
      }
      throw error;
    }

    return projections;
  }
}

// Singleton instance
let projectionStorageInstance: ProjectionStorage | null = null;

export function getProjectionStorage(): ProjectionStorage {
  if (!projectionStorageInstance) {
    projectionStorageInstance = new FilesystemProjectionStorage();
  }
  return projectionStorageInstance;
}