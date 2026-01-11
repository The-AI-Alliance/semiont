// Filesystem storage for resource content
import * as fs from 'fs/promises';
import { mkdirSync } from 'fs';
import * as path from 'path';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { getShardPath } from '@semiont/event-sourcing';
import type { ResourceId } from '@semiont/core';

export interface StorageService {
  saveResource(resourceId: ResourceId, content: string | Buffer): Promise<string>;
  getResource(resourceId: ResourceId): Promise<Buffer>;
  deleteResource(resourceId: ResourceId): Promise<void>;
  resourceExists(resourceId: ResourceId): Promise<boolean>;
  getResourcePath(resourceId: ResourceId): string;
}

export class FilesystemStorage implements StorageService {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }
  
  async ensureDirectoryExists(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }
  
  getResourcePath(resourceId: ResourceId): string {
    // Use 4-hex Jump Consistent Hash sharding (65,536 shards)
    const [ab, cd] = getShardPath(resourceId);
    return path.join(this.basePath, 'resources', ab, cd, `${resourceId}.dat`);
  }

  async saveResource(resourceId: ResourceId, content: string | Buffer): Promise<string> {
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
  
  async getResource(resourceId: ResourceId): Promise<Buffer> {
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

  async deleteResource(resourceId: ResourceId): Promise<void> {
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
  
  async resourceExists(resourceId: ResourceId): Promise<boolean> {
    const docPath = this.getResourcePath(resourceId);

    try {
      await fs.access(docPath);
      return true;
    } catch {
      return false;
    }
  }

  // Stream methods for large resources
  createReadStream(resourceId: ResourceId) {
    const docPath = this.getResourcePath(resourceId);
    return createReadStream(docPath);
  }

  createWriteStream(resourceId: ResourceId) {
    const docPath = this.getResourcePath(resourceId);
    const docDir = path.dirname(docPath);

    // Ensure directory exists synchronously for stream creation
    mkdirSync(docDir, { recursive: true });

    return createWriteStream(docPath);
  }

  async saveResourceStream(resourceId: ResourceId, stream: NodeJS.ReadableStream): Promise<string> {
    await this.ensureDirectoryExists();
    
    const docPath = this.getResourcePath(resourceId);
    const docDir = path.dirname(docPath);
    
    await fs.mkdir(docDir, { recursive: true });
    
    const writeStream = createWriteStream(docPath);
    await pipeline(stream, writeStream);
    
    return docPath;
  }
}