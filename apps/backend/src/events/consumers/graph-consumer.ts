/**
 * GraphDB Consumer
 * Subscribes to document events and updates GraphDB accordingly
 *
 * Makes GraphDB a projection of Layer 2 events (single source of truth)
 */

import { createEventStore, createEventQuery } from '../../services/event-store-service';
import { getGraphDatabase } from '../../graph/factory';
import { didToAgent } from '../../utils/id-generator';
import type { GraphDatabase } from '../../graph/interface';
import type { components } from '@semiont/api-client';
import type { DocumentEvent, StoredEvent } from '@semiont/core';
import { findBodyItem } from '@semiont/core';
import { getFilesystemConfig } from '../../config/environment-loader';

type Annotation = components['schemas']['Annotation'];

export class GraphDBConsumer {
  private graphDb: GraphDatabase | null = null;
  private subscriptions: Map<string, any> = new Map();
  private _globalSubscription: any = null;  // Subscription to system-level events (kept for cleanup)
  private processing: Map<string, Promise<void>> = new Map();
  private lastProcessed: Map<string, number> = new Map();

  async initialize() {
    if (!this.graphDb) {
      this.graphDb = await getGraphDatabase();
      console.log('[GraphDBConsumer] Initialized');

      // Subscribe to global system-level events
      await this.subscribeToGlobalEvents();
    }
  }

  /**
   * Subscribe to global system-level events (no documentId)
   * This allows the consumer to react to events like entitytype.added
   */
  private async subscribeToGlobalEvents() {
    const basePath = getFilesystemConfig().path;
    const eventStore = await createEventStore(basePath);

    this._globalSubscription = eventStore.subscriptions.subscribeGlobal(async (storedEvent) => {
      console.log(`[GraphDBConsumer] Received global event: ${storedEvent.event.type}`);
      await this.processEvent(storedEvent);
    });

    console.log('[GraphDBConsumer] Subscribed to global system events');
  }

  private ensureInitialized(): GraphDatabase {
    if (!this.graphDb) {
      throw new Error('GraphDBConsumer not initialized. Call initialize() first.');
    }
    return this.graphDb;
  }

  /**
   * Subscribe to events for a document
   * Apply each event to GraphDB
   */
  async subscribeToDocument(documentId: string) {
    this.ensureInitialized();
    const basePath = getFilesystemConfig().path;
    const eventStore = await createEventStore(basePath);

    const subscription = eventStore.subscriptions.subscribe(documentId, async (storedEvent) => {
      await this.processEvent(storedEvent);
    });

    this.subscriptions.set(documentId, subscription);
    console.log(`[GraphDBConsumer] Subscribed to ${documentId}`);
  }

  /**
   * Process event with ordering guarantee (sequential per document)
   */
  protected async processEvent(storedEvent: StoredEvent): Promise<void> {
    const { documentId } = storedEvent.event;

    // ⚠️ BRITTLE: System-level events (entitytype.added) have no documentId
    // Process these immediately without ordering guarantees
    if (!documentId) {
      await this.applyEventToGraph(storedEvent);
      return;
    }

    // Wait for previous event on this document to complete
    const previousProcessing = this.processing.get(documentId);
    if (previousProcessing) {
      await previousProcessing;
    }

    // Create new processing promise
    const processingPromise = this.applyEventToGraph(storedEvent);
    this.processing.set(documentId, processingPromise);

    try {
      await processingPromise;
      this.lastProcessed.set(documentId, storedEvent.metadata.sequenceNumber);
    } catch (error) {
      console.error(`[GraphDBConsumer] Failed to process event:`, error);
      throw error;
    } finally {
      this.processing.delete(documentId);
    }
  }

  /**
   * Apply event to GraphDB
   */
  protected async applyEventToGraph(storedEvent: StoredEvent): Promise<void> {
    const graphDb = this.ensureInitialized();
    const event = storedEvent.event;

    console.log(`[GraphDBConsumer] Applying ${event.type} to GraphDB (seq=${storedEvent.metadata.sequenceNumber})`);

    switch (event.type) {
      case 'document.created': {
        if (!event.documentId) throw new Error('document.created requires documentId');
        await graphDb.createDocument({
          id: event.documentId,
          name: event.payload.name,
          entityTypes: event.payload.entityTypes || [],
          content: '', // Content stored separately in RepresentationStore
          format: event.payload.format,
          contentChecksum: event.payload.contentChecksum,
          creator: didToAgent(event.userId),
          creationMethod: 'api',
        });
        break;
      }

      case 'document.cloned': {
        if (!event.documentId) throw new Error('document.cloned requires documentId');
        await graphDb.createDocument({
          id: event.documentId,
          name: event.payload.name,
          entityTypes: event.payload.entityTypes || [],
          content: '', // Content stored separately in RepresentationStore
          format: event.payload.format,
          contentChecksum: event.payload.contentChecksum,
          creator: didToAgent(event.userId),
          creationMethod: 'clone',
        });
        break;
      }

      case 'document.archived':
        if (!event.documentId) throw new Error('document.archived requires documentId');
        await graphDb.updateDocument(event.documentId, {
          archived: true,
        });
        break;

      case 'document.unarchived':
        if (!event.documentId) throw new Error('document.unarchived requires documentId');
        await graphDb.updateDocument(event.documentId, {
          archived: false,
        });
        break;

      case 'annotation.added':
        // Event payload contains Omit<Annotation, 'creator' | 'created'>
        // Add creator from event metadata (created not needed for graph)
        await graphDb.createAnnotation({
          ...event.payload.annotation,
          creator: didToAgent(event.userId),
        });
        break;

      case 'annotation.removed':
        await graphDb.deleteAnnotation(event.payload.annotationId);
        break;

      case 'annotation.body.updated':
        // Apply fine-grained body operations
        try {
          // Get current annotation from graph
          const currentAnnotation = await graphDb.getAnnotation(event.payload.annotationId);
          if (currentAnnotation) {
            // Ensure body is an array
            let bodyArray = Array.isArray(currentAnnotation.body)
              ? [...currentAnnotation.body]
              : currentAnnotation.body
              ? [currentAnnotation.body]
              : [];

            // Apply each operation
            for (const op of event.payload.operations) {
              if (op.op === 'add') {
                // Add item (idempotent - don't add if already exists)
                const exists = findBodyItem(bodyArray, op.item) !== -1;
                if (!exists) {
                  bodyArray.push(op.item);
                }
              } else if (op.op === 'remove') {
                // Remove item
                const index = findBodyItem(bodyArray, op.item);
                if (index !== -1) {
                  bodyArray.splice(index, 1);
                }
              } else if (op.op === 'replace') {
                // Replace item
                const index = findBodyItem(bodyArray, op.oldItem);
                if (index !== -1) {
                  bodyArray[index] = op.newItem;
                }
              }
            }

            // Update annotation with new body
            await graphDb.updateAnnotation(event.payload.annotationId, {
              body: bodyArray,
            } as Partial<Annotation>);
          }
        } catch (error) {
          // If annotation doesn't exist in graph (e.g., created before consumer started),
          // log warning but don't fail - event store is source of truth
          console.warn(`[GraphDBConsumer] Could not update annotation ${event.payload.annotationId} in graph: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        break;

      case 'entitytag.added':
        if (!event.documentId) throw new Error('entitytag.added requires documentId');
        const doc = await graphDb.getDocument(event.documentId);
        if (doc) {
          await graphDb.updateDocument(event.documentId, {
            entityTypes: [...doc.entityTypes, event.payload.entityType],
          });
        }
        break;

      case 'entitytag.removed':
        if (!event.documentId) throw new Error('entitytag.removed requires documentId');
        const doc2 = await graphDb.getDocument(event.documentId);
        if (doc2) {
          await graphDb.updateDocument(event.documentId, {
            entityTypes: doc2.entityTypes.filter(t => t !== event.payload.entityType),
          });
        }
        break;

      case 'entitytype.added':
        // ⚠️ BRITTLE: Event routing depends on absence of documentId
        // This handler is called for system-level events (global entity type collection)
        // TODO: Design cleaner event routing with explicit projection targets
        await graphDb.addEntityType(event.payload.entityType);
        break;

      default:
        console.warn(`[GraphDBConsumer] Unknown event type: ${(event as DocumentEvent).type}`);
    }
  }

  /**
   * Rebuild entire document from events
   * Useful for recovery or initial sync
   */
  async rebuildDocument(documentId: string): Promise<void> {
    const graphDb = this.ensureInitialized();
    console.log(`[GraphDBConsumer] Rebuilding document ${documentId} from events`);

    // Delete existing data
    try {
      await graphDb.deleteDocument(documentId);
    } catch (error) {
      // Document might not exist yet
      console.log(`[GraphDBConsumer] No existing document to delete: ${documentId}`);
    }

    // Replay all events
    const basePath = getFilesystemConfig().path;
    const eventStore = await createEventStore(basePath);
    const query = createEventQuery(eventStore);
    const events = await query.getDocumentEvents(documentId);

    for (const storedEvent of events) {
      await this.applyEventToGraph(storedEvent);
    }

    console.log(`[GraphDBConsumer] Rebuilt ${documentId} from ${events.length} events`);
  }

  /**
   * Rebuild entire GraphDB from all events
   * Nuclear option for recovery
   */
  async rebuildAll(): Promise<void> {
    const graphDb = this.ensureInitialized();
    console.log('[GraphDBConsumer] Rebuilding entire GraphDB from events...');

    // Clear database
    await graphDb.clearDatabase();

    // Get all document IDs by scanning event shards
    const basePath = getFilesystemConfig().path;
    const eventStore = await createEventStore(basePath);
    const allDocumentIds = await eventStore.storage.getAllDocumentIds();

    console.log(`[GraphDBConsumer] Found ${allDocumentIds.length} documents to rebuild`);

    for (const documentId of allDocumentIds) {
      await this.rebuildDocument(documentId);
    }

    console.log('[GraphDBConsumer] Rebuild complete');
  }

  /**
   * Get consumer health metrics
   */
  getHealthMetrics(): {
    subscriptions: number;
    lastProcessed: Record<string, number>;
    processing: string[];
  } {
    return {
      subscriptions: this.subscriptions.size,
      lastProcessed: Object.fromEntries(this.lastProcessed),
      processing: Array.from(this.processing.keys()),
    };
  }

  /**
   * Unsubscribe from document
   */
  async unsubscribeFromDocument(documentId: string): Promise<void> {
    const subscription = this.subscriptions.get(documentId);
    if (subscription) {
      subscription.unsubscribe();
      this.subscriptions.delete(documentId);
      console.log(`[GraphDBConsumer] Unsubscribed from ${documentId}`);
    }
  }

  /**
   * Unsubscribe from all documents
   */
  async unsubscribeAll(): Promise<void> {
    for (const [_documentId, subscription] of this.subscriptions) {
      subscription.unsubscribe();
    }
    this.subscriptions.clear();
    console.log('[GraphDBConsumer] Unsubscribed from all documents');
  }

  /**
   * Shutdown consumer
   */
  async shutdown(): Promise<void> {
    await this.unsubscribeAll();

    // Unsubscribe from global events
    if (this._globalSubscription) {
      this._globalSubscription.unsubscribe();
      this._globalSubscription = null;
      console.log('[GraphDBConsumer] Unsubscribed from global events');
    }

    if (this.graphDb) {
      await this.graphDb.disconnect();
      this.graphDb = null;
    }
    console.log('[GraphDBConsumer] Shut down');
  }
}

// Singleton instance
let graphConsumer: GraphDBConsumer | null = null;

export async function getGraphConsumer(): Promise<GraphDBConsumer> {
  if (!graphConsumer) {
    graphConsumer = new GraphDBConsumer();
    await graphConsumer.initialize();
  }
  return graphConsumer;
}

/**
 * Start consumer for existing documents
 * Called on app initialization
 */
export async function startGraphConsumer(): Promise<void> {
  const consumer = await getGraphConsumer();
  const basePath = getFilesystemConfig().path;
  const eventStore = await createEventStore(basePath);

  // Get all existing document IDs
  const allDocumentIds = await eventStore.storage.getAllDocumentIds();

  console.log(`[GraphDBConsumer] Starting consumer for ${allDocumentIds.length} documents`);

  // Subscribe to each document
  for (const documentId of allDocumentIds) {
    await consumer.subscribeToDocument(documentId);
  }

  console.log('[GraphDBConsumer] Consumer started');
}