/**
 * Layer 3: Projection Storage
 *
 * Stores materialized views of resource state and annotations
 * Built from Layer 2 event streams, can be rebuilt at any time
 *
 * Stores both ResourceDescriptor metadata and ResourceAnnotations, but keeps them logically separate
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { getShardPath } from './shard-utils';
import { getFilesystemConfig } from '../config/environment-loader';
import type { components } from '@semiont/api-client';
import type { ResourceAnnotations, ResourceId } from '@semiont/core';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

// Complete state for a resource in Layer 3 (metadata + annotations)
export interface ResourceState {
  resource: ResourceDescriptor;
  annotations: ResourceAnnotations;
}

export interface ProjectionStorage {
  saveProjection(resourceId: ResourceId, projection: ResourceState): Promise<void>;
  getProjection(resourceId: ResourceId): Promise<ResourceState | null>;
  deleteProjection(resourceId: ResourceId): Promise<void>;
  projectionExists(resourceId: ResourceId): Promise<boolean>;
  getAllProjections(): Promise<ResourceState[]>;
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

  private getProjectionPath(resourceId: ResourceId): string {
    // Use 4-hex Jump Consistent Hash sharding (65,536 shards)
    const [ab, cd] = getShardPath(resourceId);
    return path.join(this.basePath, 'projections', 'resources', ab, cd, `${resourceId}.json`);
  }

  async saveProjection(resourceId: ResourceId, projection: ResourceState): Promise<void> {
    const projPath = this.getProjectionPath(resourceId);
    const projDir = path.dirname(projPath);

    // Ensure shard directory exists
    await fs.mkdir(projDir, { recursive: true });

    // Write projection to file
    await fs.writeFile(projPath, JSON.stringify(projection, null, 2), 'utf-8');
  }

  async getProjection(resourceId: ResourceId): Promise<ResourceState | null> {
    const projPath = this.getProjectionPath(resourceId);

    try {
      const content = await fs.readFile(projPath, 'utf-8');
      return JSON.parse(content) as ResourceState;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async deleteProjection(resourceId: ResourceId): Promise<void> {
    const projPath = this.getProjectionPath(resourceId);

    try {
      await fs.unlink(projPath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // Ignore if file doesn't exist
    }
  }

  async projectionExists(resourceId: ResourceId): Promise<boolean> {
    const projPath = this.getProjectionPath(resourceId);

    try {
      await fs.access(projPath);
      return true;
    } catch {
      return false;
    }
  }

  async getAllProjections(): Promise<ResourceState[]> {
    const projections: ResourceState[] = [];
    const annotationsPath = path.join(this.basePath, 'projections', 'resources');

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
              const projection = JSON.parse(content) as ResourceState;
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
        // Projections/annotations directory doesn't exist yet
        return [];
      }
      throw error;
    }

    return projections;
  }
}