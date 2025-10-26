/**
 * ContentStorage - Layer 3 Content File I/O
 *
 * Handles ONLY file operations for document content (raw text/binary):
 * - Save content to disk
 * - Load content from disk
 * - Delete content
 * - Check existence
 *
 * NO singleton pattern - direct instantiation
 * Uses PathBuilder for sharding and path management
 */

import { promises as fs } from 'fs';
import { PathBuilder } from '../shared/path-builder';

export interface ContentStorageConfig {
  basePath: string;
}

/**
 * ContentStorage handles file I/O for document content
 *
 * Storage structure:
 * basePath/documents/ab/cd/doc-123.dat
 *
 * Stores raw content (text or binary) separately from projections
 */
export class ContentStorage {
  private pathBuilder: PathBuilder;

  constructor(config: ContentStorageConfig) {
    this.pathBuilder = new PathBuilder({
      basePath: config.basePath,
      namespace: 'documents',
    });
  }

  /**
   * Save content to disk
   *
   * @param documentId - Document identifier
   * @param content - Content (string or Buffer)
   * @returns File path where content was saved
   */
  async save(documentId: string, content: string | Buffer): Promise<string> {
    const filePath = this.pathBuilder.buildPath(documentId, '.dat');
    await this.pathBuilder.ensureDirectory(filePath);

    if (typeof content === 'string') {
      await fs.writeFile(filePath, content, 'utf-8');
    } else {
      await fs.writeFile(filePath, content);
    }

    return filePath;
  }

  /**
   * Load content from disk
   *
   * @param documentId - Document identifier
   * @returns Content as Buffer
   * @throws Error if document not found
   */
  async get(documentId: string): Promise<Buffer> {
    const filePath = this.pathBuilder.buildPath(documentId, '.dat');

    try {
      return await fs.readFile(filePath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`Document ${documentId} not found in storage`);
      }
      throw error;
    }
  }

  /**
   * Load content as string
   *
   * @param documentId - Document identifier
   * @returns Content as UTF-8 string
   * @throws Error if document not found
   */
  async getString(documentId: string): Promise<string> {
    const buffer = await this.get(documentId);
    return buffer.toString('utf-8');
  }

  /**
   * Delete content from disk
   *
   * @param documentId - Document identifier
   */
  async delete(documentId: string): Promise<void> {
    const filePath = this.pathBuilder.buildPath(documentId, '.dat');

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
   * Check if content exists
   *
   * @param documentId - Document identifier
   * @returns True if content file exists
   */
  async exists(documentId: string): Promise<boolean> {
    const filePath = this.pathBuilder.buildPath(documentId, '.dat');

    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file path for document (used by streaming)
   *
   * @param documentId - Document identifier
   * @returns Full file path
   */
  getPath(documentId: string): string {
    return this.pathBuilder.buildPath(documentId, '.dat');
  }

  /**
   * Get all document IDs that have content
   *
   * @returns Array of document IDs
   */
  async getAllDocumentIds(): Promise<string[]> {
    return this.pathBuilder.scanForDocuments('.dat');
  }
}
