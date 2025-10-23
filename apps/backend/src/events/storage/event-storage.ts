/**
 * Event Storage - Physical Storage Layer
 *
 * Handles file I/O operations for event storage:
 * - JSONL file writing/reading
 * - 4-hex sharding (65,536 shards)
 * - File rotation
 * - Event stream initialization
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { createReadStream } from 'fs';
import * as readline from 'readline';
import type { StoredEvent } from '@semiont/core';
import { jumpConsistentHash } from '../../storage/shard-utils';

export interface EventStorageConfig {
  dataDir: string;
  maxEventsPerFile?: number;     // File rotation threshold (default: 10000)
  enableSharding?: boolean;       // Enable 4-hex sharding (default: true)
  numShards?: number;             // Number of shards (default: 65536)
  enableCompression?: boolean;    // Gzip rotated files (default: true)
}

/**
 * EventStorage handles physical storage of events
 * Owns: file I/O, sharding, AND sequence/hash tracking
 */
export class EventStorage {
  private config: Required<EventStorageConfig>;

  // Per-document sequence tracking: documentId -> sequence number
  private documentSequences: Map<string, number> = new Map();
  // Per-document last event hash: documentId -> hash
  private documentLastHash: Map<string, string> = new Map();

  constructor(config: EventStorageConfig) {
    this.config = {
      dataDir: config.dataDir,
      maxEventsPerFile: config.maxEventsPerFile || 10000,
      enableSharding: config.enableSharding ?? true,
      numShards: config.numShards || 65536,
      enableCompression: config.enableCompression ?? true,
    };
  }

  /**
   * Calculate shard path for a document ID
   * Uses jump consistent hash for uniform distribution
   */
  getShardPath(documentId: string): string {
    if (!this.config.enableSharding) {
      return '';
    }

    // Jump consistent hash for uniform shard distribution
    const shardIndex = jumpConsistentHash(documentId, this.config.numShards);

    // Convert to 4-hex format (e.g., 0000, 0001, ..., ffff)
    const hex = shardIndex.toString(16).padStart(4, '0');
    const [ab, cd] = [hex.substring(0, 2), hex.substring(2, 4)];

    return path.join(ab, cd);
  }

  /**
   * Get full path to document's event directory
   */
  getDocumentPath(documentId: string): string {
    const shardPath = this.getShardPath(documentId);
    return path.join(this.config.dataDir, 'events', shardPath, documentId);
  }

  /**
   * Initialize directory structure for a document's event stream
   * Also loads sequence number and last hash if stream exists
   */
  async initializeDocumentStream(documentId: string): Promise<void> {
    const docPath = this.getDocumentPath(documentId);

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
      this.documentSequences.set(documentId, 0);

      console.log(`[EventStorage] Initialized event stream for ${documentId} at ${docPath}`);
    } else {
      // Load existing sequence number and last hash
      const files = await this.getEventFiles(documentId);
      if (files.length > 0) {
        const lastFile = files[files.length - 1];
        if (lastFile) {
          const lastEvent = await this.getLastEvent(documentId, lastFile);
          if (lastEvent) {
            this.documentSequences.set(documentId, lastEvent.metadata.sequenceNumber);
            if (lastEvent.metadata.checksum) {
              this.documentLastHash.set(documentId, lastEvent.metadata.checksum);
            }
          }
        }
      } else {
        this.documentSequences.set(documentId, 0);
      }
    }
  }

  /**
   * Write an event to storage (append to JSONL)
   */
  async writeEvent(event: StoredEvent, documentId: string): Promise<void> {
    const docPath = this.getDocumentPath(documentId);

    // Get current event files
    const files = await this.getEventFiles(documentId);

    // Determine target file (rotate if needed)
    let targetFile: string;
    if (files.length === 0) {
      // No files yet - create first one
      targetFile = await this.createNewEventFile(documentId);
    } else {
      const currentFile = files[files.length - 1];
      if (!currentFile) {
        // Shouldn't happen, but handle it
        targetFile = await this.createNewEventFile(documentId);
      } else {
        const eventCount = await this.countEventsInFile(documentId, currentFile);

        if (eventCount >= this.config.maxEventsPerFile) {
          // Rotate to new file
          targetFile = await this.createNewEventFile(documentId);
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
  async countEventsInFile(documentId: string, filename: string): Promise<number> {
    const docPath = this.getDocumentPath(documentId);
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
  async readEventsFromFile(documentId: string, filename: string): Promise<StoredEvent[]> {
    const docPath = this.getDocumentPath(documentId);
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
   * Get list of event files for a document (sorted by sequence)
   */
  async getEventFiles(documentId: string): Promise<string[]> {
    const docPath = this.getDocumentPath(documentId);

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
  async createNewEventFile(documentId: string): Promise<string> {
    const files = await this.getEventFiles(documentId);

    // Determine next sequence number
    const lastFile = files[files.length - 1];
    const lastSeq = lastFile ? parseInt(lastFile.match(/events-(\d+)\.jsonl/)?.[1] || '1') : 1;
    const newSeq = lastSeq + 1;

    // Create new file
    const filename = this.createEventFilename(newSeq);
    const docPath = this.getDocumentPath(documentId);
    const filePath = path.join(docPath, filename);

    await fs.writeFile(filePath, '', 'utf-8');

    console.log(`[EventStorage] Created new event file: ${filename} for ${documentId}`);

    return filename;
  }

  /**
   * Get the last event from a specific file
   */
  async getLastEvent(documentId: string, filename: string): Promise<StoredEvent | null> {
    const events = await this.readEventsFromFile(documentId, filename);
    const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
    return lastEvent ?? null;
  }

  /**
   * Get all events for a document across all files
   */
  async getAllEvents(documentId: string): Promise<StoredEvent[]> {
    const files = await this.getEventFiles(documentId);
    const allEvents: StoredEvent[] = [];

    for (const file of files) {
      const events = await this.readEventsFromFile(documentId, file);
      allEvents.push(...events);
    }

    return allEvents;
  }

  /**
   * Get all document IDs by scanning shard directories
   */
  async getAllDocumentIds(): Promise<string[]> {
    const eventsDir = path.join(this.config.dataDir, 'events');
    const documentIds: string[] = [];

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
          // Check if this looks like a document ID (not a shard directory)
          // Shard directories are 2-char hex (00-ff), document IDs are longer
          if (entry.name.length > 2) {
            documentIds.push(entry.name);
          } else {
            // Recurse into shard directory
            await scanDir(fullPath);
          }
        }
      }
    };

    await scanDir(eventsDir);
    return documentIds;
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
   * Get current sequence number for a document
   */
  getSequenceNumber(documentId: string): number {
    return this.documentSequences.get(documentId) || 0;
  }

  /**
   * Increment and return next sequence number for a document
   */
  getNextSequenceNumber(documentId: string): number {
    const current = this.getSequenceNumber(documentId);
    const next = current + 1;
    this.documentSequences.set(documentId, next);
    return next;
  }

  /**
   * Get last event hash for a document
   */
  getLastEventHash(documentId: string): string | null {
    return this.documentLastHash.get(documentId) || null;
  }

  /**
   * Set last event hash for a document
   */
  setLastEventHash(documentId: string, hash: string): void {
    this.documentLastHash.set(documentId, hash);
  }
}
