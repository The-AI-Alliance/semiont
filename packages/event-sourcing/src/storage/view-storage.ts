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
import type { SemiontProject } from '@semiont/core/node';
import type { components, ResourceAnnotations, ResourceId, Logger } from '@semiont/core';

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

  constructor(project: SemiontProject, logger?: Logger) {
    this.logger = logger;
    this.basePath = project.stateDir;
  }

  private getProjectionPath(resourceId: ResourceId): string {
    // Use 4-hex Jump Consistent Hash sharding (65,536 shards)
    const [ab, cd] = getShardPath(resourceId);
    return path.join(this.basePath, 'resources', ab, cd, `${resourceId}.json`);
  }

  async save(resourceId: ResourceId, projection: ResourceView): Promise<void> {
    const projPath = this.getProjectionPath(resourceId);
    const projDir = path.dirname(projPath);

    // Ensure shard directory exists
    await fs.mkdir(projDir, { recursive: true });

    // Atomic write: write to a sibling temp file and rename into place.
    // `fs.writeFile` on its own truncates the target to 0 bytes before
    // writing, so a concurrent reader can observe an empty file and
    // get a `JSON.parse('')` SyntaxError mid-write. `rename` is atomic
    // on POSIX, so readers always see either the old or new content,
    // never a partial one.
    const tmpPath = `${projPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(projection, null, 2), 'utf-8');
    try {
      await fs.rename(tmpPath, projPath);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => {});
      throw error;
    }
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
      // Don't delete on SyntaxError — the old code unlinked the file,
      // which turned a transient race (read-during-write with the
      // pre-atomic `fs.writeFile`) into a permanent "view missing"
      // that the next materializer write had to repair from scratch.
      // With atomic `rename` in `save`, SyntaxError should only fire
      // on genuine corruption; either way, the next incremental
      // update will overwrite the file with a good view, so we just
      // log and treat as missing.
      if (error instanceof SyntaxError) {
        this.logger?.error('[ViewStorage] Corrupted view file, treating as missing', {
          resourceId,
          path: projPath,
          error: error.message,
        });
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
    const annotationsPath = path.join(this.basePath, 'resources');

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