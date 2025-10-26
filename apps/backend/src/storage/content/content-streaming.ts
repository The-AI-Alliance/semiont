/**
 * ContentStreaming - Stream Operations for Large Content
 *
 * Handles stream operations for efficient large file handling:
 * - Create read streams
 * - Create write streams
 * - Save from stream
 *
 * Separated from ContentStorage for Single Responsibility Principle
 */

import { createReadStream, createWriteStream, mkdirSync } from 'fs';
import { promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import * as path from 'path';
import type { ContentStorage } from './content-storage';

/**
 * ContentStreaming provides efficient stream operations for large content
 */
export class ContentStreaming {
  constructor(private storage: ContentStorage) {}

  /**
   * Create read stream for document content
   *
   * @param documentId - Document identifier
   * @returns Readable stream
   */
  createReadStream(documentId: string): NodeJS.ReadableStream {
    const filePath = this.storage.getPath(documentId);
    return createReadStream(filePath);
  }

  /**
   * Create write stream for document content
   *
   * Ensures directory exists before creating stream
   *
   * @param documentId - Document identifier
   * @returns Writable stream
   */
  createWriteStream(documentId: string): NodeJS.WritableStream {
    const filePath = this.storage.getPath(documentId);
    const docDir = path.dirname(filePath);

    // Ensure directory exists synchronously for stream creation
    mkdirSync(docDir, { recursive: true });

    return createWriteStream(filePath);
  }

  /**
   * Save content from stream
   *
   * @param documentId - Document identifier
   * @param stream - Readable stream with content
   * @returns File path where content was saved
   */
  async saveStream(documentId: string, stream: NodeJS.ReadableStream): Promise<string> {
    const filePath = this.storage.getPath(documentId);
    const docDir = path.dirname(filePath);

    // Ensure directory exists
    await fs.mkdir(docDir, { recursive: true });

    // Pipe stream to file
    const writeStream = createWriteStream(filePath);
    await pipeline(stream, writeStream);

    return filePath;
  }
}
