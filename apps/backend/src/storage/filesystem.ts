// Filesystem storage for resource content
import * as fs from 'fs/promises';
import { mkdirSync } from 'fs';
import * as path from 'path';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { getFilesystemConfig } from '../config/config';
import { getShardPath } from './shard-utils';

export interface StorageService {
  saveResource(resourceId: string, content: string | Buffer): Promise<string>;
  getResource(resourceId: string): Promise<Buffer>;
  deleteResource(resourceId: string): Promise<void>;
  resourceExists(resourceId: string): Promise<boolean>;
  getResourcePath(resourceId: string): string;
}

export class FilesystemStorage implements StorageService {
  private basePath: string;
  
  constructor(basePath?: string) {
    if (basePath) {
      this.basePath = basePath;
    } else {
      const config = getFilesystemConfig();
      this.basePath = config.path;
    }
  }
  
  async ensureDirectoryExists(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }
  
  getResourcePath(resourceId: string): string {
    // Use 4-hex Jump Consistent Hash sharding (65,536 shards)
    const [ab, cd] = getShardPath(resourceId);
    return path.join(this.basePath, 'resources', ab, cd, `${resourceId}.dat`);
  }
  
  async saveResource(resourceId: string, content: string | Buffer): Promise<string> {
    await this.ensureDirectoryExists();
    
    const docPath = this.getResourcePath(resourceId);
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
  
  async getResource(resourceId: string): Promise<Buffer> {
    const docPath = this.getResourcePath(resourceId);
    
    try {
      return await fs.readFile(docPath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`Resource ${resourceId} not found in storage`);
      }
      throw error;
    }
  }
  
  async deleteResource(resourceId: string): Promise<void> {
    const docPath = this.getResourcePath(resourceId);
    
    try {
      await fs.unlink(docPath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // Ignore if file doesn't exist
    }
  }
  
  async resourceExists(resourceId: string): Promise<boolean> {
    const docPath = this.getResourcePath(resourceId);
    
    try {
      await fs.access(docPath);
      return true;
    } catch {
      return false;
    }
  }
  
  // Stream methods for large resources
  createReadStream(resourceId: string) {
    const docPath = this.getResourcePath(resourceId);
    return createReadStream(docPath);
  }
  
  createWriteStream(resourceId: string) {
    const docPath = this.getResourcePath(resourceId);
    const docDir = path.dirname(docPath);
    
    // Ensure directory exists synchronously for stream creation
    mkdirSync(docDir, { recursive: true });
    
    return createWriteStream(docPath);
  }
  
  async saveResourceStream(resourceId: string, stream: NodeJS.ReadableStream): Promise<string> {
    await this.ensureDirectoryExists();
    
    const docPath = this.getResourcePath(resourceId);
    const docDir = path.dirname(docPath);
    
    await fs.mkdir(docDir, { recursive: true });
    
    const writeStream = createWriteStream(docPath);
    await pipeline(stream, writeStream);
    
    return docPath;
  }
}