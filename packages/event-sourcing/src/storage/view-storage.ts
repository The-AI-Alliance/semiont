/**
 * View Storage - Materialized Views
 *
 * Stores materialized views of resource state and annotations
 * Built from event streams, can be rebuilt at any time
 *
 * Stores both ResourceDescriptor metadata and ResourceAnnotations, but keeps them logically separate
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { getShardPath } from './shard-utils';
import type { components } from '@semiont/core';
import type { ResourceAnnotations, ResourceId, Logger } from '@semiont/core';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

// Complete state for a resource in materialized view (metadata + annotations)
export interface ResourceView {
  resource: ResourceDescriptor;
  annotations: ResourceAnnotations;
}

export interface ViewStorage {
  save(resourceId: ResourceId, view: ResourceView): Promise<void>;
  get(resourceId: ResourceId): Promise<ResourceView | null>;
  delete(resourceId: ResourceId): Promise<void>;
  exists(resourceId: ResourceId): Promise<boolean>;
  getAll(): Promise<ResourceView[]>;
}

export class FilesystemViewStorage implements ViewStorage {
  private basePath: string;
  private logger?: Logger;

  constructor(basePath: string, projectRoot?: string, logger?: Logger) {
    this.logger = logger;
    // If path is absolute, use it directly
    if (path.isAbsolute(basePath)) {
      this.basePath = basePath;
    }
    // If projectRoot provided, resolve relative paths against it
    else if (projectRoot) {
      this.basePath = path.resolve(projectRoot, basePath);
    }
    // Otherwise fall back to resolving against cwd (backward compat)
    else {
      this.basePath = path.resolve(basePath);
    }
  }

  private getProjectionPath(resourceId: ResourceId): string {
    // Use 4-hex Jump Consistent Hash sharding (65,536 shards)
    const [ab, cd] = getShardPath(resourceId);
    return path.join(this.basePath, 'projections', 'resources', ab, cd, `${resourceId}.json`);
  }

  async save(resourceId: ResourceId, projection: ResourceView): Promise<void> {
    const projPath = this.getProjectionPath(resourceId);
    const projDir = path.dirname(projPath);

    // Ensure shard directory exists
    await fs.mkdir(projDir, { recursive: true });

    // Write projection to file
    await fs.writeFile(projPath, JSON.stringify(projection, null, 2), 'utf-8');
  }

  async get(resourceId: ResourceId): Promise<ResourceView | null> {
    const projPath = this.getProjectionPath(resourceId);

    try {
      const content = await fs.readFile(projPath, 'utf-8');
      return JSON.parse(content) as ResourceView;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      // Auto-delete corrupted view files (views are derived data, can be rebuilt from events)
      // This only handles JSON parsing errors, not broken event chains
      if (error instanceof SyntaxError) {
        this.logger?.error('[ViewStorage] Corrupted view file detected', { resourceId, error: error.message });
        this.logger?.error('[ViewStorage] Deleting corrupted view file', { path: projPath });
        try {
          await fs.unlink(projPath);
        } catch (unlinkError) {
          this.logger?.error('[ViewStorage] Failed to delete corrupted file', { error: unlinkError });
        }
        return null;
      }
      throw error;
    }
  }

  async delete(resourceId: ResourceId): Promise<void> {
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

  async exists(resourceId: ResourceId): Promise<boolean> {
    const projPath = this.getProjectionPath(resourceId);

    try {
      await fs.access(projPath);
      return true;
    } catch {
      return false;
    }
  }

  async getAll(): Promise<ResourceView[]> {
    const views: ResourceView[] = [];
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
              const view = JSON.parse(content) as ResourceView;
              views.push(view);
            } catch (error) {
              this.logger?.error('[ViewStorage] Failed to read view', { path: fullPath, error });
              // Skip invalid view files
            }
          }
        }
      };

      await walkDir(annotationsPath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Views directory doesn't exist yet
        return [];
      }
      throw error;
    }

    return views;
  }
}