/**
 * Storage URI Index
 *
 * Projection that maps file:// URIs → resourceIds.
 * Sharded at:
 *   {projectionsDir}/storage-uri/{ab}/{cd}/{uri-hash}.json
 *
 * where {ab}/{cd} comes from jumpConsistentHash(uri) and
 * {uri-hash} is the SHA-256 of the URI string.
 *
 * Each file contains: { uri: string; resourceId: string }
 *
 * This index is maintained by ViewMaterializer (the single owner).
 * It is never modified by Stower or other actors.
 *
 * Archive/unarchive do NOT remove entries from this index.
 * Archived resources are marked in the ResourceView (archived: true)
 * but remain findable by URI.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getShardPath, sha256 } from './shard-utils';

export interface StorageUriEntry {
  uri: string;
  resourceId: string;
}

/**
 * Thrown when a URI is not found in the storage-uri index.
 */
export class ResourceNotFoundError extends Error {
  constructor(readonly uri: string) {
    super(`No resource found for URI: ${uri}`);
    this.name = 'ResourceNotFoundError';
  }
}

/**
 * Resolve a file:// URI to a resourceId using the storage-uri index.
 *
 * @param projectionsDir - Path to the projections directory
 * @param uri - file:// URI (e.g. "file://docs/overview.md")
 * @returns resourceId
 * @throws ResourceNotFoundError if URI is not in the index
 */
export async function resolveStorageUri(
  projectionsDir: string,
  uri: string,
): Promise<string> {
  const entryPath = uriIndexPath(projectionsDir, uri);
  try {
    const raw = await fs.readFile(entryPath, 'utf-8');
    const entry: StorageUriEntry = JSON.parse(raw);
    return entry.resourceId;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new ResourceNotFoundError(uri);
    }
    throw error;
  }
}

/**
 * Write a URI → resourceId mapping to the index.
 *
 * Called by ViewMaterializer when handling resource.created, resource.moved.
 *
 * @param projectionsDir - Path to the projections directory
 * @param uri - file:// URI
 * @param resourceId - resourceId to map to
 */
export async function writeStorageUriEntry(
  projectionsDir: string,
  uri: string,
  resourceId: string,
): Promise<void> {
  const entryPath = uriIndexPath(projectionsDir, uri);
  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  const entry: StorageUriEntry = { uri, resourceId };
  await fs.writeFile(entryPath, JSON.stringify(entry, null, 2));
}

/**
 * Remove a URI entry from the index.
 *
 * Called by ViewMaterializer when handling resource.moved (old URI only).
 * NOT called on resource.archived — archived resources retain their index entry.
 *
 * @param projectionsDir - Path to the projections directory
 * @param uri - file:// URI to remove
 */
export async function removeStorageUriEntry(
  projectionsDir: string,
  uri: string,
): Promise<void> {
  const entryPath = uriIndexPath(projectionsDir, uri);
  try {
    await fs.unlink(entryPath);
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Compute the filesystem path for a URI index entry.
 */
function uriIndexPath(projectionsDir: string, uri: string): string {
  const uriHash = sha256(uri);
  const [ab, cd] = getShardPath(uri);
  return path.join(projectionsDir, 'storage-uri', ab, cd, `${uriHash}.json`);
}
