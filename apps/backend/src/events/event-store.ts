/**
 * Event Store Implementation
 *
 * Append-only event store using JSONL (JSON Lines) format
 * - Per-document event streams for isolation
 * - 4-hex Jump Consistent Hash sharding (65,536 shards)
 * - Event chain integrity with prevEventHash
 * - Content-addressed documents
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { createReadStream } from 'fs';
import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import type {
  DocumentEvent,
  StoredEvent,
  EventQuery,
  EventMetadata,
  DocumentProjection,
} from '@semiont/core-types';
import type { ProjectionStorage } from '../storage/projection-storage';
import { jumpConsistentHash, sha256 } from '../storage/shard-utils';

export interface EventStoreConfig {
  dataDir: string;
  maxEventsPerFile?: number;     // File rotation threshold (default: 10000)
  enableSharding?: boolean;       // Enable 4-hex sharding (default: true)
  numShards?: number;             // Number of shards (default: 65536)
  enableCompression?: boolean;    // Gzip rotated files (default: true)
}

export type EventCallback = (event: StoredEvent) => void | Promise<void>;

export interface EventSubscription {
  documentId: string;
  callback: EventCallback;
  unsubscribe: () => void;
}

export class EventStore {
  private config: Required<EventStoreConfig>;
  private projectionStorage: ProjectionStorage;
  // Per-document sequence tracking: documentId -> sequence number
  private documentSequences: Map<string, number> = new Map();
  // Per-document last event hash: documentId -> hash
  private documentLastHash: Map<string, string> = new Map();
  // Per-document subscriptions: documentId -> Set of callbacks
  private subscriptions: Map<string, Set<EventCallback>> = new Map();

  constructor(config: EventStoreConfig, projectionStorage: ProjectionStorage) {
    this.config = {
      dataDir: config.dataDir,
      maxEventsPerFile: config.maxEventsPerFile || 10000,
      enableSharding: config.enableSharding ?? true,
      numShards: config.numShards || 65536,  // 4 hex digits = 16^4
      enableCompression: config.enableCompression ?? true,
    };
    this.projectionStorage = projectionStorage;
  }

  async initialize(): Promise<void> {
    // Ensure base data directory exists
    await fs.mkdir(this.config.dataDir, { recursive: true });

    if (this.config.enableSharding) {
      const shardsPath = path.join(this.config.dataDir, 'shards');
      await fs.mkdir(shardsPath, { recursive: true });
    }
  }


  /**
   * Get the shard path for a document
   */
  private getShardPath(documentId: string): string {
    if (!this.config.enableSharding) {
      return this.config.dataDir;
    }

    const shardNum = jumpConsistentHash(documentId, this.config.numShards);
    const shardHex = shardNum.toString(16).padStart(4, '0');

    // Two-level structure for filesystem efficiency
    const prefix = shardHex.substring(0, 2);
    const suffix = shardHex.substring(2, 4);

    return path.join(this.config.dataDir, 'shards', prefix, suffix);
  }

  /**
   * Get the document event directory
   */
  private getDocumentPath(documentId: string): string {
    const shardPath = this.getShardPath(documentId);
    return path.join(shardPath, 'documents', documentId);
  }

  /**
   * Initialize document stream (create directory if needed)
   */
  private async initializeDocumentStream(documentId: string): Promise<void> {
    const docPath = this.getDocumentPath(documentId);
    await fs.mkdir(docPath, { recursive: true });

    // Load existing sequence number and last hash if stream exists
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

  /**
   * Append an event to the store
   */
  async appendEvent(event: Omit<DocumentEvent, 'id' | 'timestamp'>): Promise<StoredEvent> {
    const documentId = event.documentId;

    if (!documentId) {
      throw new Error('Event must have a documentId');
    }

    // Ensure document stream is initialized
    if (!this.documentSequences.has(documentId)) {
      await this.initializeDocumentStream(documentId);
    }

    const completeEvent: DocumentEvent = {
      ...event,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
    } as DocumentEvent;

    const sequenceNumber = (this.documentSequences.get(documentId) || 0) + 1;
    const prevEventHash = this.documentLastHash.get(documentId) || null;

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

    // Write to file
    await this.writeEvent(storedEvent, documentId);

    // Update tracking
    this.documentSequences.set(documentId, sequenceNumber);
    this.documentLastHash.set(documentId, metadata.checksum!);

    // Update projection incrementally (Layer 3)
    await this.updateProjectionIncremental(documentId, completeEvent);

    // Notify subscribers
    await this.notifySubscribers(documentId, storedEvent);

    return storedEvent;
  }

  /**
   * Query events with filters
   */
  async queryEvents(query: EventQuery): Promise<StoredEvent[]> {
    if (!query.documentId) {
      throw new Error('documentId is required for event queries');
    }

    const files = await this.getEventFiles(query.documentId);
    const results: StoredEvent[] = [];

    for (const file of files) {
      const events = await this.readEventsFromFile(query.documentId, file, query);
      results.push(...events);

      if (query.limit && results.length >= query.limit) {
        return results.slice(0, query.limit);
      }
    }

    return results;
  }

  /**
   * Get all events for a specific document
   */
  async getDocumentEvents(documentId: string): Promise<StoredEvent[]> {
    return this.queryEvents({ documentId });
  }

  /**
   * Validate event chain integrity
   */
  async validateEventChain(documentId: string): Promise<{ valid: boolean; errors: string[] }> {
    const events = await this.getDocumentEvents(documentId);
    const errors: string[] = [];

    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];

      if (!prev || !curr) continue;

      // Check prevEventHash points to previous event
      if (curr.metadata.prevEventHash !== prev.metadata.checksum) {
        errors.push(
          `Event chain broken at sequence ${curr.metadata.sequenceNumber}: ` +
          `prevEventHash=${curr.metadata.prevEventHash} but previous checksum=${prev.metadata.checksum}`
        );
      }

      // Verify checksum of current event
      const calculated = sha256(curr.event);
      if (calculated !== curr.metadata.checksum) {
        errors.push(
          `Checksum mismatch at sequence ${curr.metadata.sequenceNumber}: ` +
          `calculated=${calculated} but stored=${curr.metadata.checksum}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Build document projection from events
   * Loads from Layer 3 if exists, otherwise rebuilds from Layer 2 events
   */
  async projectDocument(documentId: string): Promise<DocumentProjection | null> {
    // Try to load existing projection from Layer 3
    const existing = await this.projectionStorage.getProjection(documentId);
    if (existing) {
      return existing;
    }

    // No projection exists - rebuild from Layer 2 events
    const events = await this.getDocumentEvents(documentId);
    if (events.length === 0) return null;

    const projection = this.buildProjectionFromEvents(events, documentId);

    // Save rebuilt projection to Layer 3
    await this.projectionStorage.saveProjection(documentId, projection);

    return projection;
  }

  /**
   * Update projection incrementally with a single event
   * Falls back to full rebuild if projection doesn't exist
   */
  private async updateProjectionIncremental(documentId: string, event: DocumentEvent): Promise<void> {
    // Try to load existing projection
    let projection = await this.projectionStorage.getProjection(documentId);

    if (!projection) {
      // No projection exists - do full rebuild from all events
      const events = await this.getDocumentEvents(documentId);
      projection = this.buildProjectionFromEvents(events, documentId);
    } else {
      // Apply single event incrementally to existing projection
      this.applyEventToProjection(projection, event);
      projection.version++;
      projection.updatedAt = event.timestamp;
    }

    // Save updated projection
    await this.projectionStorage.saveProjection(documentId, projection);
  }

  /**
   * Build projection from event list (full rebuild)
   */
  private buildProjectionFromEvents(events: StoredEvent[], documentId: string): DocumentProjection {
    // Start with empty projection
    const projection: DocumentProjection = {
      id: documentId,
      name: '',
      content: '',
      contentType: 'text/markdown',
      entityTypes: [],
      highlights: [],
      references: [],
      archived: false,
      createdAt: '',
      updatedAt: '',
      version: 0,
    };

    // Apply events in sequenceNumber order
    events.sort((a, b) => a.metadata.sequenceNumber - b.metadata.sequenceNumber);

    for (const storedEvent of events) {
      this.applyEventToProjection(projection, storedEvent.event);
      projection.version++;
      projection.updatedAt = storedEvent.event.timestamp;
    }

    return projection;
  }

  /**
   * Apply an event to a projection
   */
  private applyEventToProjection(projection: DocumentProjection, event: DocumentEvent): void {
    switch (event.type) {
      case 'document.created':
        projection.name = event.payload.name;
        projection.contentType = event.payload.contentType;
        projection.entityTypes = event.payload.entityTypes || [];
        projection.createdAt = event.timestamp;
        // Note: content is NOT in events - must be loaded from filesystem separately
        break;

      case 'document.cloned':
        projection.name = event.payload.name;
        projection.contentType = event.payload.contentType;
        projection.entityTypes = event.payload.entityTypes || [];
        projection.createdAt = event.timestamp;
        // Note: content is NOT in events - must be loaded from filesystem separately
        break;

      case 'document.archived':
        projection.archived = true;
        break;

      case 'document.unarchived':
        projection.archived = false;
        break;

      case 'highlight.added':
        projection.highlights.push({
          id: event.payload.highlightId,
          text: event.payload.text,
          position: event.payload.position,
        });
        break;

      case 'highlight.removed':
        projection.highlights = projection.highlights.filter(
          h => h.id !== event.payload.highlightId
        );
        break;

      case 'reference.created':
        projection.references.push({
          id: event.payload.referenceId,
          text: event.payload.text,
          position: event.payload.position,
          targetDocumentId: event.payload.targetDocumentId,
          entityTypes: event.payload.entityTypes,
          referenceType: event.payload.referenceType,
        });
        break;

      case 'reference.resolved':
        const ref = projection.references.find(r => r.id === event.payload.referenceId);
        if (ref) {
          ref.targetDocumentId = event.payload.targetDocumentId;
          if (event.payload.referenceType) {
            ref.referenceType = event.payload.referenceType;
          }
        }
        break;

      case 'reference.deleted':
        projection.references = projection.references.filter(
          r => r.id !== event.payload.referenceId
        );
        break;

      case 'entitytag.added':
        if (!projection.entityTypes.includes(event.payload.entityType)) {
          projection.entityTypes.push(event.payload.entityType);
        }
        break;

      case 'entitytag.removed':
        projection.entityTypes = projection.entityTypes.filter(
          t => t !== event.payload.entityType
        );
        break;
    }
  }

  /**
   * Write event to JSONL file
   */
  private async writeEvent(event: StoredEvent, documentId: string): Promise<void> {
    const docPath = this.getDocumentPath(documentId);
    const files = await this.getEventFiles(documentId);

    // Determine current file
    let currentFile: string;
    if (files.length === 0) {
      currentFile = await this.createNewEventFile(documentId);
    } else {
      const lastFile = files[files.length - 1];
      if (!lastFile) {
        currentFile = await this.createNewEventFile(documentId);
      } else {
        currentFile = lastFile;

        // Check if we need to rotate
        const eventCount = await this.countEventsInFile(documentId, currentFile);
        if (eventCount >= this.config.maxEventsPerFile) {
          // TODO: Optionally gzip the old file here if enableCompression is true
          currentFile = await this.createNewEventFile(documentId);
        }
      }
    }

    const line = JSON.stringify(event) + '\n';
    const filePath = path.join(docPath, currentFile);

    await fs.appendFile(filePath, line, 'utf8');
  }

  /**
   * Count events in a file
   */
  private async countEventsInFile(documentId: string, filename: string): Promise<number> {
    const docPath = this.getDocumentPath(documentId);
    const filePath = path.join(docPath, filename);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content.trim().split('\n').filter(line => line.trim()).length;
    } catch (error: any) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  /**
   * Read events from a file with optional filtering
   */
  private async readEventsFromFile(
    documentId: string,
    filename: string,
    query: EventQuery
  ): Promise<StoredEvent[]> {
    const docPath = this.getDocumentPath(documentId);
    const filePath = path.join(docPath, filename);
    const results: StoredEvent[] = [];

    try {
      const fileStream = createReadStream(filePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;

        try {
          const storedEvent: StoredEvent = JSON.parse(line);

          // Apply filters
          if (query.userId && storedEvent.event.userId !== query.userId) {
            continue;
          }
          if (query.eventTypes && !query.eventTypes.includes(storedEvent.event.type)) {
            continue;
          }
          if (query.fromTimestamp && storedEvent.event.timestamp < query.fromTimestamp) {
            continue;
          }
          if (query.toTimestamp && storedEvent.event.timestamp > query.toTimestamp) {
            continue;
          }
          if (query.fromSequence && storedEvent.metadata.sequenceNumber < query.fromSequence) {
            continue;
          }

          results.push(storedEvent);

          if (query.limit && results.length >= query.limit) {
            break;
          }
        } catch (error) {
          console.error(`Failed to parse event line: ${line}`, error);
        }
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet, return empty results
        return [];
      }
      throw error;
    }

    return results;
  }

  /**
   * Get list of event files for a document in order
   */
  private async getEventFiles(documentId: string): Promise<string[]> {
    const docPath = this.getDocumentPath(documentId);

    try {
      const files = await fs.readdir(docPath);
      return files
        .filter(f => f.endsWith('.jsonl'))
        .sort((a, b) => {
          const aNum = parseInt(a.split('-')[1] || '0');
          const bNum = parseInt(b.split('-')[1] || '0');
          return aNum - bNum;
        });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Directory doesn't exist yet, return empty array
        return [];
      }
      throw error;
    }
  }

  /**
   * Create a new event file for a document
   */
  private async createNewEventFile(documentId: string): Promise<string> {
    const docPath = this.getDocumentPath(documentId);
    const timestamp = Date.now();
    const files = await this.getEventFiles(documentId);
    const sequence = files.length;
    const filename = `events-${sequence.toString().padStart(6, '0')}-${timestamp}.jsonl`;

    const filePath = path.join(docPath, filename);
    await fs.writeFile(filePath, '', 'utf8');

    return filename;
  }

  /**
   * Get the last event from a file
   */
  private async getLastEvent(documentId: string, filename: string): Promise<StoredEvent | null> {
    const docPath = this.getDocumentPath(documentId);
    const filePath = path.join(docPath, filename);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.trim().split('\n');

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line && line.trim()) {
          try {
            return JSON.parse(line);
          } catch (error) {
            console.error(`Failed to parse last event: ${line}`, error);
          }
        }
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }

    return null;
  }

  /**
   * Subscribe to events for a specific document
   * Returns an EventSubscription with unsubscribe function
   */
  subscribe(documentId: string, callback: EventCallback): EventSubscription {
    if (!this.subscriptions.has(documentId)) {
      this.subscriptions.set(documentId, new Set());
    }

    const callbacks = this.subscriptions.get(documentId)!;
    callbacks.add(callback);

    return {
      documentId,
      callback,
      unsubscribe: () => {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.subscriptions.delete(documentId);
        }
      }
    };
  }

  /**
   * Notify all subscribers for a document when a new event is appended
   */
  private async notifySubscribers(documentId: string, event: StoredEvent): Promise<void> {
    const callbacks = this.subscriptions.get(documentId);
    if (!callbacks || callbacks.size === 0) return;

    // Call all callbacks in parallel
    await Promise.all(
      Array.from(callbacks).map(async (callback) => {
        try {
          await callback(event);
        } catch (error) {
          console.error(`Error in event subscriber for document ${documentId}:`, error);
          // Don't throw - keep notifying other subscribers
        }
      })
    );
  }

  /**
   * Get subscription count for a document (useful for debugging)
   */
  getSubscriptionCount(documentId: string): number {
    return this.subscriptions.get(documentId)?.size || 0;
  }

  /**
   * Get total number of active subscriptions across all documents
   */
  getTotalSubscriptions(): number {
    let total = 0;
    for (const callbacks of this.subscriptions.values()) {
      total += callbacks.size;
    }
    return total;
  }

  /**
   * Get all document IDs in the event store
   * Scans shard directories to find all documents
   */
  async getAllDocumentIds(): Promise<string[]> {
    const documentIds: string[] = [];

    if (!this.config.enableSharding) {
      const documentsPath = path.join(this.config.dataDir, 'documents');
      try {
        const docs = await fs.readdir(documentsPath);
        return docs;
      } catch (error: any) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    }

    // Scan all shards
    const shardsPath = path.join(this.config.dataDir, 'shards');
    try {
      const prefixes = await fs.readdir(shardsPath);

      for (const prefix of prefixes) {
        const prefixPath = path.join(shardsPath, prefix);
        const stat = await fs.stat(prefixPath);
        if (!stat.isDirectory()) continue;

        const suffixes = await fs.readdir(prefixPath);
        for (const suffix of suffixes) {
          const suffixPath = path.join(prefixPath, suffix);
          const suffixStat = await fs.stat(suffixPath);
          if (!suffixStat.isDirectory()) continue;

          const documentsPath = path.join(suffixPath, 'documents');
          try {
            const docs = await fs.readdir(documentsPath);
            documentIds.push(...docs);
          } catch (error: any) {
            if (error.code === 'ENOENT') continue;
            throw error;
          }
        }
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    return documentIds;
  }

  /**
   * Validate projection matches event stream
   * Useful for debugging and ensuring Layer 3 stays in sync with Layer 2
   */
  async validateProjection(documentId: string): Promise<{
    valid: boolean;
    errors: string[];
    projection: DocumentProjection | null;
    rebuilt?: DocumentProjection;
  }> {
    const projection = await this.projectionStorage.getProjection(documentId);
    if (!projection) {
      return {
        valid: false,
        errors: ['Projection does not exist'],
        projection: null,
      };
    }

    // Rebuild from events
    const events = await this.getDocumentEvents(documentId);
    if (events.length === 0) {
      return {
        valid: false,
        errors: ['No events found for document'],
        projection,
      };
    }

    const rebuilt = this.buildProjectionFromEvents(events, documentId);
    const errors: string[] = [];

    // Compare key fields
    if (projection.version !== rebuilt.version) {
      errors.push(
        `Version mismatch: projection=${projection.version} rebuilt=${rebuilt.version}`
      );
    }

    if (projection.name !== rebuilt.name) {
      errors.push(
        `Name mismatch: projection="${projection.name}" rebuilt="${rebuilt.name}"`
      );
    }

    if (projection.highlights.length !== rebuilt.highlights.length) {
      errors.push(
        `Highlight count mismatch: projection=${projection.highlights.length} rebuilt=${rebuilt.highlights.length}`
      );
    }

    if (projection.references.length !== rebuilt.references.length) {
      errors.push(
        `Reference count mismatch: projection=${projection.references.length} rebuilt=${rebuilt.references.length}`
      );
    }

    if (projection.entityTypes.length !== rebuilt.entityTypes.length) {
      errors.push(
        `Entity type count mismatch: projection=${projection.entityTypes.length} rebuilt=${rebuilt.entityTypes.length}`
      );
    }

    if (projection.archived !== rebuilt.archived) {
      errors.push(
        `Archived status mismatch: projection=${projection.archived} rebuilt=${rebuilt.archived}`
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      projection,
      rebuilt: errors.length > 0 ? rebuilt : undefined,
    };
  }
}

// Singleton instance
let eventStore: EventStore | null = null;

export async function getEventStore(config?: EventStoreConfig): Promise<EventStore> {
  if (!eventStore) {
    const { getProjectionStorage } = await import('../storage/projection-storage');
    const projectionStorage = getProjectionStorage();

    const dataDir = config?.dataDir || process.env.EVENT_STORE_DIR || './data/events';
    eventStore = new EventStore({
      dataDir,
      enableSharding: true,
      numShards: 65536,  // 4 hex digits
      ...config
    }, projectionStorage);
    await eventStore.initialize();
  }
  return eventStore;
}