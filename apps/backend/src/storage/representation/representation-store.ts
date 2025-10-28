/**
 * RepresentationStore - Content-addressed storage for byte-level resource representations
 *
 * Handles storage and retrieval of concrete byte-level renditions of resources.
 * Uses content-addressed storage where the checksum IS the filename.
 * Supports multiple storage backends (filesystem, S3, IPFS, etc.)
 *
 * Storage structure (filesystem):
 * basePath/representations/{mediaType}/{ab}/{cd}/rep-{checksum}.dat
 *
 * Where:
 * - {mediaType} is MIME type with "/" encoded as "~1" (e.g., "text~1markdown")
 * - {ab}/{cd} are first 4 hex digits of checksum for sharding
 * - {checksum} is the raw SHA-256 hex hash (e.g., "5aaa0b72abc123...")
 *
 * Example:
 * For content with checksum "5aaa0b72abc123..." and mediaType "text/markdown":
 * basePath/representations/text~1markdown/5a/aa/rep-5aaa0b72abc123....dat
 *
 * This design provides:
 * - O(1) content retrieval by checksum + mediaType
 * - Automatic deduplication (identical content = same file)
 * - Idempotent storage operations
 */

import { promises as fs } from 'fs';
import path from 'path';
import { calculateChecksum } from '@semiont/core';

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
   * Retrieve content by checksum (content-addressed)
   *
   * @param checksum - Content checksum as raw hex (e.g., "5aaa0b72...")
   * @param mediaType - MIME type (e.g., "text/markdown")
   * @returns Raw bytes
   */
  retrieveByChecksum(checksum: string, mediaType: string): Promise<Buffer>;

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
    // Compute checksum (raw hex) - this will be used as the content address
    const checksum = calculateChecksum(content);
    const mediaTypePath = this.encodeMediaType(metadata.mediaType);

    if (!checksum || checksum.length < 4) {
      throw new Error(`Invalid checksum: ${checksum}`);
    }

    // Use first 4 hex digits for sharding: 5a/aa
    const ab = checksum.substring(0, 2);
    const cd = checksum.substring(2, 4);

    // Build file path using raw hex checksum as filename
    const filePath = path.join(
      this.basePath,
      'representations',
      mediaTypePath,
      ab,
      cd,
      `rep-${checksum}.dat`
    );

    // Create directory structure programmatically
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Write content (idempotent - same content = same file)
    await fs.writeFile(filePath, content);

    // Build storage URI (still provided for compatibility but not needed for retrieval)
    const storageUri = `file://${path.resolve(filePath)}`;

    return {
      '@id': checksum, // Use checksum as the ID (content-addressed)
      ...metadata,
      storageUri,
      byteSize: content.length,
      checksum,
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

  async retrieveByChecksum(checksum: string, mediaType: string): Promise<Buffer> {
    const mediaTypePath = this.encodeMediaType(mediaType);

    if (!checksum || checksum.length < 4) {
      throw new Error(`Invalid checksum: ${checksum}`);
    }

    // Use first 4 hex digits for sharding: 5a/aa
    const ab = checksum.substring(0, 2);
    const cd = checksum.substring(2, 4);

    // Build file path from raw hex checksum
    const filePath = path.join(
      this.basePath,
      'representations',
      mediaTypePath,
      ab,
      cd,
      `rep-${checksum}.dat`
    );

    try {
      return await fs.readFile(filePath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`Representation not found for checksum ${checksum} with mediaType ${mediaType}`);
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
