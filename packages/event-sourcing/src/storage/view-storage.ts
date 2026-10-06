/**
 * View Storage - reading materialized views
 *
 * A resource's view is the file the Archivist keeps at
 * `<resourcesDir>/<ab>/<cd>/<resourceId>.json`: what the resource's events
 * add up to. This is the read side; the Archivist is the only writer.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { getShardPath, isObject, resourceId as makeResourceId } from '@semiont/core';
import type { components, ResourceId, Logger } from '@semiont/core';

/** A resource's metadata and annotations, with the sequence of the last event applied. */
export type ResourceView = components['schemas']['ResourceView'];

export interface ViewStorage {
  get(resourceId: ResourceId): Promise<ResourceView | null>;
}

export class FilesystemViewStorage implements ViewStorage {
  private resourcesDir: string;
  private logger?: Logger;

  // Takes only the views' own directory — not a full SemiontProject, and not
  // the whole state tree: this store can name nothing outside resourcesDir.
  // The Librarian resolves it from the staged `[kb] name` with no KB mount.
  constructor(state: { resourcesDir: string }, logger?: Logger) {
    this.logger = logger;
    this.resourcesDir = state.resourcesDir;
  }

  private viewPath(resourceId: ResourceId): string {
    // The type says this is an id, and a type is not there at run time. Here
    // an id becomes a file's name, so the rule is asked of the text itself:
    // `..` must never reach `path.join`.
    const name = makeResourceId(resourceId);
    const [ab, cd] = getShardPath(name);
    return path.join(this.resourcesDir, ab, cd, `${name}.json`);
  }

  async get(resourceId: ResourceId): Promise<ResourceView | null> {
    const viewPath = this.viewPath(resourceId);

    try {
      const content = await fs.readFile(viewPath, 'utf-8');
      return JSON.parse(content) as ResourceView;
    } catch (error) {
      if (isObject(error) && error.code === 'ENOENT') {
        return null;
      }
      // The writer renames whole files into place, so a SyntaxError is
      // genuine corruption. The writer's next update replaces the file;
      // until then the view reads as missing.
      if (error instanceof SyntaxError) {
        this.logger?.error('[ViewStorage] Corrupted view file, treating as missing', {
          resourceId,
          path: viewPath,
          error: error.message,
        });
        return null;
      }
      throw error;
    }
  }
}
