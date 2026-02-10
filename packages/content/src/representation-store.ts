/**
 * RepresentationStore - Content-addressed storage for byte-level resource representations
 *
 * Handles storage and retrieval of concrete byte-level renditions of resources.
 * Uses content-addressed storage where the checksum IS the filename.
 * Supports multiple storage backends (filesystem, S3, IPFS, etc.)
 *
 * Storage structure (filesystem):
 * basePath/representations/{mediaType}/{ab}/{cd}/rep-{checksum}{extension}
 *
 * Where:
 * - {mediaType} is base MIME type with "/" encoded as "~1" (e.g., "text~1markdown")
 * - {ab}/{cd} are first 4 hex digits of checksum for sharding
 * - {checksum} is the raw SHA-256 hex hash (e.g., "5aaa0b72abc123...")
 * - {extension} is derived from base MIME type (.md, .txt, .png, etc.)
 *
 * Example:
 * For content with checksum "5aaa0b72abc123..." and mediaType "text/markdown; charset=iso-8859-1":
 * - Storage path: basePath/representations/text~1markdown/5a/aa/rep-5aaa0b72abc123....md
 * - Stored mediaType: "text/markdown; charset=iso-8859-1" (full type with charset preserved)
 *
 * Character Encoding:
 * - Charset parameters in mediaType are preserved in metadata (e.g., "text/plain; charset=iso-8859-1")
 * - Storage path uses only base MIME type (strips charset for directory structure)
 * - Content stored as raw bytes - charset only affects decoding on retrieval
 *
 * This design provides:
 * - O(1) content retrieval by checksum + mediaType
 * - Automatic deduplication (identical content = same file)
 * - Idempotent storage operations
 * - Proper file extensions for filesystem browsing
 * - Faithful preservation of character encoding metadata
 */

import { promises as fs } from 'fs';
import path from 'path';
import { calculateChecksum } from './checksum';
import { getExtensionForMimeType } from './mime-extensions';

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
 * Complete representation information
 */
export interface StoredRepresentation extends RepresentationMetadata {
  '@id': string;           // Representation ID (same as checksum)
  byteSize: number;        // Size in bytes
  checksum: string;        // Raw SHA-256 hex hash
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
   * @returns Complete representation info with checksum
   */
  store(content: Buffer, metadata: RepresentationMetadata): Promise<StoredRepresentation>;

  /**
   * Retrieve content by checksum (content-addressed lookup)
   *
   * @param checksum - Content checksum as raw hex (e.g., "5aaa0b72...")
   * @param mediaType - MIME type (e.g., "text/markdown")
   * @returns Raw bytes
   */
  retrieve(checksum: string, mediaType: string): Promise<Buffer>;
}

/**
 * Filesystem implementation of RepresentationStore
 */
export class FilesystemRepresentationStore implements RepresentationStore {
  private basePath: string;

  constructor(
    config: { basePath: string },
    projectRoot?: string
  ) {
    // If path is absolute, use it directly
    if (path.isAbsolute(config.basePath)) {
      this.basePath = config.basePath;
    }
    // If projectRoot provided, resolve relative paths against it
    else if (projectRoot) {
      this.basePath = path.resolve(projectRoot, config.basePath);
    }
    // Otherwise fall back to resolving against cwd (backward compat)
    else {
      this.basePath = path.resolve(config.basePath);
    }
  }

  async store(content: Buffer, metadata: RepresentationMetadata): Promise<StoredRepresentation> {
    // Compute checksum (raw hex) - this will be used as the content address
    const checksum = calculateChecksum(content);

    // Strip charset/parameters for path - only use base MIME type for directory structure
    // e.g., "text/plain; charset=iso-8859-1" -> "text/plain"
    const baseMediaType = metadata.mediaType.split(';')[0]!.trim();
    const mediaTypePath = this.encodeMediaType(baseMediaType);
    const extension = getExtensionForMimeType(baseMediaType);

    if (!checksum || checksum.length < 4) {
      throw new Error(`Invalid checksum: ${checksum}`);
    }

    // Use first 4 hex digits for sharding: 5a/aa
    const ab = checksum.substring(0, 2);
    const cd = checksum.substring(2, 4);

    // Build file path using raw hex checksum as filename with proper extension
    const filePath = path.join(
      this.basePath,
      'representations',
      mediaTypePath,
      ab,
      cd,
      `rep-${checksum}${extension}`
    );

    // Create directory structure programmatically
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Write content (idempotent - same content = same file)
    await fs.writeFile(filePath, content);

    return {
      '@id': checksum, // Use checksum as the ID (content-addressed)
      ...metadata,
      byteSize: content.length,
      checksum,
      created: new Date().toISOString(),
    };
  }

  async retrieve(checksum: string, mediaType: string): Promise<Buffer> {
    // Strip charset/parameters for path - only use base MIME type for directory lookup
    // e.g., "text/plain; charset=iso-8859-1" -> "text/plain"
    const baseMediaType = mediaType.split(';')[0]!.trim();
    const mediaTypePath = this.encodeMediaType(baseMediaType);
    const extension = getExtensionForMimeType(baseMediaType);

    if (!checksum || checksum.length < 4) {
      throw new Error(`Invalid checksum: ${checksum}`);
    }

    // Use first 4 hex digits for sharding: 5a/aa
    const ab = checksum.substring(0, 2);
    const cd = checksum.substring(2, 4);

    // Build file path from raw hex checksum with proper extension
    const filePath = path.join(
      this.basePath,
      'representations',
      mediaTypePath,
      ab,
      cd,
      `rep-${checksum}${extension}`
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
}
