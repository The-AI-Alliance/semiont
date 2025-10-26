/**
 * ContentManager - Layer 3 Content Orchestration
 *
 * Coordinates content operations across specialized modules:
 * - ContentStorage: File I/O operations
 * - ContentStreaming: Stream operations
 *
 * Similar to EventStore pattern: orchestration only, delegates to modules
 *
 * NO singleton pattern
 * Direct instantiation
 *
 * @see docs/EVENT-STORE.md for comparison with Layer 2 architecture
 */

import { ContentStorage, type ContentStorageConfig } from './content-storage';
import { ContentStreaming } from './content-streaming';

export type { ContentStorageConfig as ContentManagerConfig };

/**
 * ContentManager coordinates Layer 3 content operations
 *
 * Delegates to specialized modules for focused functionality
 * NO state - just coordination between modules
 */
export class ContentManager {
  readonly storage: ContentStorage;
  readonly streaming: ContentStreaming;

  constructor(config: ContentStorageConfig) {
    this.storage = new ContentStorage(config);
    this.streaming = new ContentStreaming(this.storage);
  }

  /**
   * Save content to storage
   *
   * @param documentId - Document identifier
   * @param content - Content (string or Buffer)
   * @returns File path where content was saved
   */
  async save(documentId: string, content: string | Buffer): Promise<string> {
    return this.storage.save(documentId, content);
  }

  /**
   * Get content from storage
   *
   * @param documentId - Document identifier
   * @returns Content as Buffer
   */
  async get(documentId: string): Promise<Buffer> {
    return this.storage.get(documentId);
  }

  /**
   * Get content as string
   *
   * @param documentId - Document identifier
   * @returns Content as UTF-8 string
   */
  async getString(documentId: string): Promise<string> {
    return this.storage.getString(documentId);
  }

  /**
   * Delete content from storage
   *
   * @param documentId - Document identifier
   */
  async delete(documentId: string): Promise<void> {
    await this.storage.delete(documentId);
  }

  /**
   * Check if content exists
   *
   * @param documentId - Document identifier
   * @returns True if content exists
   */
  async exists(documentId: string): Promise<boolean> {
    return this.storage.exists(documentId);
  }

  /**
   * Get all document IDs
   *
   * @returns Array of document IDs
   */
  async getAllDocumentIds(): Promise<string[]> {
    return this.storage.getAllDocumentIds();
  }

  // Streaming methods

  /**
   * Create read stream for document content
   *
   * @param documentId - Document identifier
   * @returns Readable stream
   */
  createReadStream(documentId: string): NodeJS.ReadableStream {
    return this.streaming.createReadStream(documentId);
  }

  /**
   * Create write stream for document content
   *
   * @param documentId - Document identifier
   * @returns Writable stream
   */
  createWriteStream(documentId: string): NodeJS.WritableStream {
    return this.streaming.createWriteStream(documentId);
  }

  /**
   * Save content from stream
   *
   * @param documentId - Document identifier
   * @param stream - Readable stream with content
   * @returns File path where content was saved
   */
  async saveStream(documentId: string, stream: NodeJS.ReadableStream): Promise<string> {
    return this.streaming.saveStream(documentId, stream);
  }
}
