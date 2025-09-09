// Filesystem storage for document content
import * as fs from 'fs/promises';
import { mkdirSync } from 'fs';
import * as path from 'path';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

export interface StorageService {
  saveDocument(documentId: string, content: string | Buffer): Promise<string>;
  getDocument(documentId: string): Promise<Buffer>;
  deleteDocument(documentId: string): Promise<void>;
  documentExists(documentId: string): Promise<boolean>;
  getDocumentPath(documentId: string): string;
}

export class FilesystemStorage implements StorageService {
  private basePath: string;
  
  constructor(basePath?: string) {
    // Use EFS mount path in production, local storage in development
    this.basePath = basePath || process.env.EFS_MOUNT_PATH || '/tmp/semiont/documents';
  }
  
  async ensureDirectoryExists(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }
  
  getDocumentPath(documentId: string): string {
    // Use first 2 chars for directory sharding to avoid too many files in one directory
    const shard = documentId.substring(0, 2);
    return path.join(this.basePath, shard, `${documentId}.dat`);
  }
  
  async saveDocument(documentId: string, content: string | Buffer): Promise<string> {
    await this.ensureDirectoryExists();
    
    const docPath = this.getDocumentPath(documentId);
    const docDir = path.dirname(docPath);
    
    // Ensure shard directory exists
    await fs.mkdir(docDir, { recursive: true });
    
    // Write content to file
    if (typeof content === 'string') {
      await fs.writeFile(docPath, content, 'utf-8');
    } else {
      await fs.writeFile(docPath, content);
    }
    
    return docPath;
  }
  
  async getDocument(documentId: string): Promise<Buffer> {
    const docPath = this.getDocumentPath(documentId);
    
    try {
      return await fs.readFile(docPath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`Document ${documentId} not found in storage`);
      }
      throw error;
    }
  }
  
  async deleteDocument(documentId: string): Promise<void> {
    const docPath = this.getDocumentPath(documentId);
    
    try {
      await fs.unlink(docPath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // Ignore if file doesn't exist
    }
  }
  
  async documentExists(documentId: string): Promise<boolean> {
    const docPath = this.getDocumentPath(documentId);
    
    try {
      await fs.access(docPath);
      return true;
    } catch {
      return false;
    }
  }
  
  // Stream methods for large documents
  createReadStream(documentId: string) {
    const docPath = this.getDocumentPath(documentId);
    return createReadStream(docPath);
  }
  
  createWriteStream(documentId: string) {
    const docPath = this.getDocumentPath(documentId);
    const docDir = path.dirname(docPath);
    
    // Ensure directory exists synchronously for stream creation
    mkdirSync(docDir, { recursive: true });
    
    return createWriteStream(docPath);
  }
  
  async saveDocumentStream(documentId: string, stream: NodeJS.ReadableStream): Promise<string> {
    await this.ensureDirectoryExists();
    
    const docPath = this.getDocumentPath(documentId);
    const docDir = path.dirname(docPath);
    
    await fs.mkdir(docDir, { recursive: true });
    
    const writeStream = createWriteStream(docPath);
    await pipeline(stream, writeStream);
    
    return docPath;
  }
}

// Singleton instance
let storageInstance: StorageService | null = null;

export function getStorageService(): StorageService {
  if (!storageInstance) {
    storageInstance = new FilesystemStorage();
  }
  return storageInstance;
}