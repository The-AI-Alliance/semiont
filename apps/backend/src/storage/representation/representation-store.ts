/**
 * RepresentationStore - Storage for byte-level resource representations
 *
 * Handles storage and retrieval of concrete byte-level renditions of resources.
 * Supports multiple storage backends (filesystem, S3, IPFS, etc.)
 *
 * Storage structure (filesystem):
 * basePath/representations/{mediaType}/ab/cd/rep-{id}.dat
 *
 * Example:
 * basePath/representations/text~1markdown/ab/cd/rep-123.dat
 * basePath/representations/image~1png/12/34/rep-456.dat
 */

import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getShardPath } from '../shard-utils';

/**
 * Metadata for a representation being stored
 */
export interface RepresentationMetadata {
  mediaType: string;        // REQUIRED - MIME type
  filename?: string;
  encoding?: string;
  language?: string;
  rel?: 'original' | 'thumbnail' | 'preview' | 'optimized' | 'derived' | 'other';
}

/**
 * Complete representation information including storage location
 */
export interface StoredRepresentation extends RepresentationMetadata {
  '@id': string;           // Representation ID
  storageUri: string;      // Where the bytes live
  byteSize: number;        // Size in bytes
  checksum: string;        // sha256 hash
  created: string;         // ISO 8601 timestamp
}

/**
 * Interface for representation storage backends
 */
export interface RepresentationStore {
  /**
   * Store content and return representation metadata
   *
   * @param content - Raw bytes to store
   * @param metadata - Representation metadata
   * @returns Complete representation info including storageUri
   */
  store(content: Buffer, metadata: RepresentationMetadata): Promise<StoredRepresentation>;

  /**
   * Retrieve content by storage URI
   *
   * @param storageUri - Storage location (file://, s3://, etc.)
   * @returns Raw bytes
   */
  retrieve(storageUri: string): Promise<Buffer>;

  /**
   * Delete representation by storage URI
   *
   * @param storageUri - Storage location
   */
  delete(storageUri: string): Promise<void>;

  /**
   * Check if representation exists
   *
   * @param storageUri - Storage location
   * @returns True if exists
   */
  exists(storageUri: string): Promise<boolean>;

  /**
   * Calculate checksum for content
   *
   * @param content - Raw bytes
   * @returns SHA-256 hash in format "sha256:..."
   */
  checksum(content: Buffer): string;
}

/**
 * Filesystem implementation of RepresentationStore
 */
export class FilesystemRepresentationStore implements RepresentationStore {
  private basePath: string;

  constructor(config: { basePath: string }) {
    this.basePath = path.resolve(config.basePath);
  }

  async store(content: Buffer, metadata: RepresentationMetadata): Promise<StoredRepresentation> {
    const repId = uuidv4();
    const mediaTypePath = this.encodeMediaType(metadata.mediaType);
    const [ab, cd] = getShardPath(repId);

    // Build file path: basePath/representations/{mediaType}/ab/cd/rep-{id}.dat
    const filePath = path.join(
      this.basePath,
      'representations',
      mediaTypePath,
      ab,
      cd,
      `rep-${repId}.dat`
    );

    // Create directory structure programmatically
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Write content
    await fs.writeFile(filePath, content);

    // Build storage URI
    const storageUri = `file://${path.resolve(filePath)}`;

    return {
      '@id': `urn:semiont:representation:${repId}`,
      ...metadata,
      storageUri,
      byteSize: content.length,
      checksum: this.checksum(content),
      created: new Date().toISOString(),
    };
  }

  async retrieve(storageUri: string): Promise<Buffer> {
    const filePath = this.uriToPath(storageUri);

    try {
      return await fs.readFile(filePath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`Representation not found at ${storageUri}`);
      }
      throw error;
    }
  }

  async delete(storageUri: string): Promise<void> {
    const filePath = this.uriToPath(storageUri);

    try {
      await fs.unlink(filePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // Ignore if file doesn't exist
    }
  }

  async exists(storageUri: string): Promise<boolean> {
    const filePath = this.uriToPath(storageUri);

    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  checksum(content: Buffer): string {
    const hash = createHash('sha256').update(content).digest('hex');
    return `sha256:${hash}`;
  }

  /**
   * Encode media type for filesystem path
   * Replaces "/" with "~1" to avoid directory separators
   *
   * @param mediaType - MIME type (e.g., "text/markdown")
   * @returns Encoded path segment (e.g., "text~1markdown")
   */
  private encodeMediaType(mediaType: string): string {
    return mediaType.replace(/\//g, '~1');
  }

  /**
   * Convert file:// URI to filesystem path
   *
   * @param storageUri - Storage URI
   * @returns Filesystem path
   */
  private uriToPath(storageUri: string): string {
    if (!storageUri.startsWith('file://')) {
      throw new Error(`Unsupported storage URI scheme: ${storageUri}`);
    }
    return storageUri.replace('file://', '');
  }
}
