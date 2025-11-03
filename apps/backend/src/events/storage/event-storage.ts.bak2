/**
 * Event Storage - Physical Storage Layer
 *
 * Handles file I/O operations for event storage:
 * - JSONL file writing/reading
 * - 4-hex sharding (65,536 shards)
 * - File rotation
 * - Event stream initialization
 *
 * @see docs/EVENT-STORE.md#eventstorage for architecture details
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { createReadStream } from 'fs';
import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import type { StoredEvent, ResourceEvent, EventMetadata } from '@semiont/core';
import { resourceId, userId, annotationId } from '@semiont/core';
import { jumpConsistentHash, sha256 } from '../../storage/shard-utils';

export interface EventStorageConfig {
  basePath: string;              // Base path (e.g., /data/uploads)
  dataDir: string;               // Events directory (e.g., /data/uploads/events)
  maxEventsPerFile?: number;     // File rotation threshold (default: 10000)
  enableSharding?: boolean;      // Enable 4-hex sharding (default: true)
  numShards?: number;            // Number of shards (default: 65536)
  enableCompression?: boolean;   // Gzip rotated files (default: true)
}

/**
 * EventStorage handles physical storage of events
 * Owns: file I/O, sharding, AND sequence/hash tracking
 */
export class EventStorage {
  private config: Required<EventStorageConfig>;

  // Per-resource sequence tracking: resourceId -> sequence number
  private resourceSequences: Map<string, number> = new Map();
  // Per-resource last event hash: resourceId -> hash
  private resourceLastHash: Map<string, string> = new Map();

  constructor(config: EventStorageConfig) {
    this.config = {
      basePath: config.basePath,
      dataDir: config.dataDir,
      maxEventsPerFile: config.maxEventsPerFile || 10000,
      enableSharding: config.enableSharding ?? true,
      numShards: config.numShards || 65536,
      enableCompression: config.enableCompression ?? true,
    };
  }

  /**
   * Calculate shard path for a resource ID
   * Uses jump consistent hash for uniform distribution
   * Special case: __system__ events bypass sharding
   */
  getShardPath(resourceId: string): string {
    // System events don't get sharded
    if (resourceId === '__system__' || !this.config.enableSharding) {
      return '';
    }

    // Jump consistent hash for uniform shard distribution
    const shardIndex = jumpConsistentHash(resourceId, this.config.numShards);

    // Convert to 4-hex format (e.g., 0000, 0001, ..., ffff)
    const hex = shardIndex.toString(16).padStart(4, '0');
    const [ab, cd] = [hex.substring(0, 2), hex.substring(2, 4)];

    return path.join(ab, cd);
  }

  /**
   * Get full path to resource's event directory
   */
  getResourcePath(resourceId: string): string {
    const shardPath = this.getShardPath(resourceId);
    return path.join(this.config.dataDir, 'events', shardPath, resourceId);
  }

  /**
   * Initialize directory structure for a resource's event stream
   * Also loads sequence number and last hash if stream exists
   */
  async initializeResourceStream(resourceId: string): Promise<void> {
    const docPath = this.getResourcePath(resourceId);

    // Check if already initialized
    let exists = false;
    try {
      await fs.access(docPath);
      exists = true;
    } catch {
      // Doesn't exist, create it
    }

    if (!exists) {
      // Create directory structure
      await fs.mkdir(docPath, { recursive: true });

      // Create initial empty events file
      const filename = this.createEventFilename(1);
      const filePath = path.join(docPath, filename);
      await fs.writeFile(filePath, '', 'utf-8');

      // Initialize sequence number
      this.resourceSequences.set(resourceId, 0);

      console.log(`[EventStorage] Initialized event stream for ${resourceId} at ${docPath}`);
    } else {
      // Load existing sequence number and last hash
      const files = await this.getEventFiles(resourceId);
      if (files.length > 0) {
        const lastFile = files[files.length - 1];
        if (lastFile) {
          const lastEvent = await this.getLastEvent(resourceId, lastFile);
          if (lastEvent) {
            this.resourceSequences.set(resourceId, lastEvent.metadata.sequenceNumber);
            if (lastEvent.metadata.checksum) {
              this.resourceLastHash.set(resourceId, lastEvent.metadata.checksum);
            }
          }
        }
      } else {
        this.resourceSequences.set(resourceId, 0);
      }
    }
  }

  /**
   * Append an event - handles EVERYTHING for event creation
   * Creates ID, timestamp, metadata, checksum, sequence tracking, and writes to disk
   */
  async appendEvent(event: Omit<ResourceEvent, 'id' | 'timestamp'>, resourceId: string): Promise<StoredEvent> {
    // Ensure resource stream is initialized
    if (this.getSequenceNumber(resourceId) === 0) {
      await this.initializeResourceStream(resourceId);
    }

    // Create complete event with ID and timestamp
    const completeEvent: ResourceEvent = {
      ...event,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
    } as ResourceEvent;

    // Calculate metadata
    const sequenceNumber = this.getNextSequenceNumber(resourceId);
    const prevEventHash = this.getLastEventHash(resourceId);

    const metadata: EventMetadata = {
      sequenceNumber,
      streamPosition: 0,  // Will be set during write
      timestamp: new Date().toISOString(),
      prevEventHash: prevEventHash || undefined,
      checksum: sha256(completeEvent),
    };

    const storedEvent: StoredEvent = {
      event: completeEvent,
      metadata,
    };

    // Write to disk
    await this.writeEvent(storedEvent, resourceId);

    // Update last hash
    this.setLastEventHash(resourceId, metadata.checksum!);

    return storedEvent;
  }

  /**
   * Write an event to storage (append to JSONL)
   * Internal method - use appendEvent() instead
   */
  private async writeEvent(event: StoredEvent, resourceId: string): Promise<void> {
    const docPath = this.getResourcePath(resourceId);

    // Get current event files
    const files = await this.getEventFiles(resourceId);

    // Determine target file (rotate if needed)
    let targetFile: string;
    if (files.length === 0) {
      // No files yet - create first one
      targetFile = await this.createNewEventFile(resourceId);
    } else {
      const currentFile = files[files.length - 1];
      if (!currentFile) {
        // Shouldn't happen, but handle it
        targetFile = await this.createNewEventFile(resourceId);
      } else {
        const eventCount = await this.countEventsInFile(resourceId, currentFile);

        if (eventCount >= this.config.maxEventsPerFile) {
          // Rotate to new file
          targetFile = await this.createNewEventFile(resourceId);
        } else {
          targetFile = currentFile;
        }
      }
    }

    // Append event to file (JSONL format)
    const targetPath = path.join(docPath, targetFile);
    const eventLine = JSON.stringify(event) + '\n';
    await fs.appendFile(targetPath, eventLine, 'utf-8');
  }

  /**
   * Count events in a specific file
   */
  async countEventsInFile(resourceId: string, filename: string): Promise<number> {
    const docPath = this.getResourcePath(resourceId);
    const filePath = path.join(docPath, filename);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim() !== '');
      return lines.length;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  }

  /**
   * Read all events from a specific file
   */
  async readEventsFromFile(resourceId: string, filename: string): Promise<StoredEvent[]> {
    const docPath = this.getResourcePath(resourceId);
    const filePath = path.join(docPath, filename);

    const events: StoredEvent[] = [];

    try {
      const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed === '') continue;

        try {
          const event = JSON.parse(trimmed) as StoredEvent;
          events.push(event);
        } catch (parseError) {
          console.error(`[EventStorage] Failed to parse event in ${filePath}:`, parseError);
          // Skip malformed lines
        }
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return []; // File doesn't exist
      }
      throw error;
    }

    return events;
  }

  /**
   * Get list of event files for a resource (sorted by sequence)
   */
  async getEventFiles(resourceId: string): Promise<string[]> {
    const docPath = this.getResourcePath(resourceId);

    try {
      const files = await fs.readdir(docPath);

      // Filter to .jsonl files and sort by sequence number
      const eventFiles = files
        .filter(f => f.startsWith('events-') && f.endsWith('.jsonl'))
        .sort((a, b) => {
          const seqA = parseInt(a.match(/events-(\d+)\.jsonl/)?.[1] || '0');
          const seqB = parseInt(b.match(/events-(\d+)\.jsonl/)?.[1] || '0');
          return seqA - seqB;
        });

      return eventFiles;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return []; // Directory doesn't exist
      }
      throw error;
    }
  }

  /**
   * Create a new event file for rotation
   */
  async createNewEventFile(resourceId: string): Promise<string> {
    const files = await this.getEventFiles(resourceId);

    // Determine next sequence number
    const lastFile = files[files.length - 1];
    const lastSeq = lastFile ? parseInt(lastFile.match(/events-(\d+)\.jsonl/)?.[1] || '1') : 1;
    const newSeq = lastSeq + 1;

    // Create new file
    const filename = this.createEventFilename(newSeq);
    const docPath = this.getResourcePath(resourceId);
    const filePath = path.join(docPath, filename);

    await fs.writeFile(filePath, '', 'utf-8');

    console.log(`[EventStorage] Created new event file: ${filename} for ${resourceId}`);

    return filename;
  }

  /**
   * Get the last event from a specific file
   */
  async getLastEvent(resourceId: string, filename: string): Promise<StoredEvent | null> {
    const events = await this.readEventsFromFile(resourceId, filename);
    const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
    return lastEvent ?? null;
  }

  /**
   * Get all events for a resource across all files
   */
  async getAllEvents(resourceId: string): Promise<StoredEvent[]> {
    const files = await this.getEventFiles(resourceId);
    const allEvents: StoredEvent[] = [];

    for (const file of files) {
      const events = await this.readEventsFromFile(resourceId, file);
      allEvents.push(...events);
    }

    return allEvents;
  }

  /**
   * Get all resource IDs by scanning shard directories
   */
  async getAllResourceIds(): Promise<string[]> {
    const eventsDir = path.join(this.config.dataDir, 'events');
    const resourceIds: string[] = [];

    try {
      await fs.access(eventsDir);
    } catch {
      return []; // No events directory yet
    }

    // Recursively scan shard directories
    const scanDir = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Check if this looks like a resource ID (not a shard directory)
          // Shard directories are 2-char hex (00-ff), resource IDs are longer
          if (entry.name.length > 2) {
            resourceIds.push(entry.name);
          } else {
            // Recurse into shard directory
            await scanDir(fullPath);
          }
        }
      }
    };

    await scanDir(eventsDir);
    return resourceIds;
  }

  /**
   * Create filename for event file
   */
  private createEventFilename(sequenceNumber: number): string {
    return `events-${sequenceNumber.toString().padStart(6, '0')}.jsonl`;
  }

  // ============================================================
  // Sequence/Hash Tracking
  // ============================================================

  /**
   * Get current sequence number for a resource
   */
  getSequenceNumber(resourceId: string): number {
    return this.resourceSequences.get(resourceId) || 0;
  }

  /**
   * Increment and return next sequence number for a resource
   */
  getNextSequenceNumber(resourceId: string): number {
    const current = this.getSequenceNumber(resourceId);
    const next = current + 1;
    this.resourceSequences.set(resourceId, next);
    return next;
  }

  /**
   * Get last event hash for a resource
   */
  getLastEventHash(resourceId: string): string | null {
    return this.resourceLastHash.get(resourceId) || null;
  }

  /**
   * Set last event hash for a resource
   */
  setLastEventHash(resourceId: string, hash: string): void {
    this.resourceLastHash.set(resourceId, hash);
  }
}
