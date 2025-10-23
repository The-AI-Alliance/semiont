/**
 * Event Store - Orchestration Layer
 *
 * Thin orchestrator that delegates to specialized modules:
 * - EventStorage: File I/O operations
 * - EventProjector: Projection building
 * - EventSubscriptions: Real-time pub/sub
 * - EventValidator: Chain integrity validation
 * - EventQuery: Read operations
 *
 * This class is now ~200 lines instead of ~1000, focusing on coordination.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  DocumentEvent,
  StoredEvent,
  EventQuery as EventQueryType,
  EventMetadata,
} from '@semiont/core';
import type { ProjectionStorage, DocumentState } from '../storage/projection-storage';
import { sha256 } from '../storage/shard-utils';

// Import extracted modules
import { EventStorage, type EventStorageConfig } from './storage/event-storage';
import { EventProjector, type ProjectorConfig } from './projections/event-projector';
import { EventSubscriptions } from './subscriptions/event-subscriptions';
import type { EventCallback, EventSubscription } from './subscriptions/event-subscriptions';
import { EventValidator } from './validation/event-validator';
import { EventQuery } from './query/event-query';

export interface EventStoreConfig {
  dataDir: string;
  maxEventsPerFile?: number;     // File rotation threshold (default: 10000)
  enableSharding?: boolean;       // Enable 4-hex sharding (default: true)
  numShards?: number;             // Number of shards (default: 65536)
  enableCompression?: boolean;    // Gzip rotated files (default: true)
}

/**
 * EventStore orchestrates event sourcing operations
 * Delegates to specialized modules for focused functionality
 * NO state - just coordination between modules
 */
export class EventStore {
  private storage: EventStorage;
  private projector: EventProjector;
  private subscriptions: EventSubscriptions;
  private validator: EventValidator;
  private query: EventQuery;

  constructor(config: EventStoreConfig, projectionStorage: ProjectionStorage) {
    // Initialize storage module
    const storageConfig: EventStorageConfig = {
      dataDir: config.dataDir,
      maxEventsPerFile: config.maxEventsPerFile || 10000,
      enableSharding: config.enableSharding ?? true,
      numShards: config.numShards || 65536,
      enableCompression: config.enableCompression ?? true,
    };
    this.storage = new EventStorage(storageConfig);

    // Initialize projector module
    const projectorConfig: ProjectorConfig = {
      dataDir: config.dataDir,
    };
    this.projector = new EventProjector(projectionStorage, projectorConfig);

    // Initialize other modules
    this.subscriptions = new EventSubscriptions();
    this.validator = new EventValidator();
    this.query = new EventQuery(this.storage);
  }

  /**
   * Initialize event store (create directories)
   */
  async initialize(): Promise<void> {
    // Storage handles directory creation
    // No additional initialization needed for other modules
  }

  /**
   * Initialize document stream
   * Delegates to storage - it handles everything
   */
  private async initializeDocumentStream(documentId: string): Promise<void> {
    await this.storage.initializeDocumentStream(documentId);
  }

  /**
   * Append an event to the store
   * Main entry point for writing events
   */
  async appendEvent(event: Omit<DocumentEvent, 'id' | 'timestamp'>): Promise<StoredEvent> {
    const documentId = event.documentId;

    // System-level events (entitytype.added) have no documentId
    if (!documentId) {
      return this.appendSystemEvent(event);
    }

    // Ensure document stream is initialized
    if (this.storage.getSequenceNumber(documentId) === 0) {
      await this.initializeDocumentStream(documentId);
    }

    // Create complete event with ID and timestamp
    const completeEvent: DocumentEvent = {
      ...event,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
    } as DocumentEvent;

    // Calculate metadata using storage methods
    const sequenceNumber = this.storage.getNextSequenceNumber(documentId);
    const prevEventHash = this.storage.getLastEventHash(documentId);

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

    // Write to storage
    await this.storage.writeEvent(storedEvent, documentId);

    // Update last hash in storage
    this.storage.setLastEventHash(documentId, metadata.checksum!);

    // Update projection incrementally (Layer 3)
    await this.projector.updateProjectionIncremental(
      documentId,
      completeEvent,
      () => this.query.getDocumentEvents(documentId)
    );

    // Notify subscribers
    await this.subscriptions.notifySubscribers(documentId, storedEvent);

    return storedEvent;
  }

  /**
   * Append system-level event (no documentId)
   */
  private async appendSystemEvent(event: Omit<DocumentEvent, 'id' | 'timestamp'>): Promise<StoredEvent> {
    const completeEvent: DocumentEvent = {
      ...event,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
    } as DocumentEvent;

    const metadata: EventMetadata = {
      sequenceNumber: 1,  // System events don't have sequence tracking yet
      streamPosition: 0,
      timestamp: new Date().toISOString(),
      checksum: sha256(completeEvent),
    };

    const storedEvent: StoredEvent = {
      event: completeEvent,
      metadata,
    };

    // Update system projection (entity types)
    if (completeEvent.type === 'entitytype.added') {
      const payload = completeEvent.payload as any;
      await this.projector.updateEntityTypesProjection(payload.tag);
    }

    // Notify global subscribers
    await this.subscriptions.notifyGlobalSubscribers(storedEvent);

    return storedEvent;
  }

  // ============================================================
  // Query Operations (delegate to EventQuery)
  // ============================================================

  /**
   * Query events with filters
   */
  async queryEvents(query: EventQueryType): Promise<StoredEvent[]> {
    return this.query.queryEvents(query);
  }

  /**
   * Get all events for a specific document
   */
  async getDocumentEvents(documentId: string): Promise<StoredEvent[]> {
    return this.query.getDocumentEvents(documentId);
  }

  // ============================================================
  // Projection Operations (delegate to EventProjector)
  // ============================================================

  /**
   * Build document projection from events
   */
  async projectDocument(documentId: string): Promise<DocumentState | null> {
    const events = await this.query.getDocumentEvents(documentId);
    return this.projector.projectDocument(events, documentId);
  }

  // ============================================================
  // Validation Operations (delegate to EventValidator)
  // ============================================================

  /**
   * Validate event chain integrity
   */
  async validateEventChain(documentId: string): Promise<{ valid: boolean; errors: string[] }> {
    const events = await this.query.getDocumentEvents(documentId);
    return this.validator.validateEventChain(events);
  }

  // ============================================================
  // Subscription Operations (delegate to EventSubscriptions)
  // ============================================================

  /**
   * Subscribe to events for a specific document
   */
  subscribe(documentId: string, callback: EventCallback): EventSubscription {
    return this.subscriptions.subscribe(documentId, callback);
  }

  /**
   * Subscribe to all system-level events
   */
  subscribeGlobal(callback: EventCallback): EventSubscription {
    return this.subscriptions.subscribeGlobal(callback);
  }

  /**
   * Get subscription count for a document
   */
  getSubscriptionCount(documentId: string): number {
    return this.subscriptions.getSubscriptionCount(documentId);
  }

  /**
   * Get total number of active subscriptions
   */
  getTotalSubscriptions(): number {
    return this.subscriptions.getTotalSubscriptions();
  }

  // ============================================================
  // Storage Operations (delegate to EventStorage)
  // ============================================================

  /**
   * Get all document IDs in the event store
   */
  async getAllDocumentIds(): Promise<string[]> {
    return this.storage.getAllDocumentIds();
  }
}
