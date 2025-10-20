/**
 * GraphDB Consumer
 * Subscribes to document events and updates GraphDB accordingly
 *
 * Makes GraphDB a projection of Layer 2 events (single source of truth)
 */

import { getEventStore } from '../event-store';
import { getGraphDatabase } from '../../graph/factory';
import { getStorageService } from '../../storage/filesystem';
import { didToAgent } from '../../utils/id-generator';
import type { GraphDatabase } from '../../graph/interface';
import type { DocumentEvent, StoredEvent, Annotation } from '@semiont/core';

export class GraphDBConsumer {
  private graphDb: GraphDatabase | null = null;
  private subscriptions: Map<string, any> = new Map();
  private processing: Map<string, Promise<void>> = new Map();
  private lastProcessed: Map<string, number> = new Map();

  async initialize() {
    if (!this.graphDb) {
      this.graphDb = await getGraphDatabase();
      console.log('[GraphDBConsumer] Initialized');
    }
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
    const eventStore = await getEventStore();

    const subscription = eventStore.subscribe(documentId, async (storedEvent) => {
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
        const storage = getStorageService();
        const content = await storage.getDocument(event.documentId);
        await graphDb.createDocument({
          id: event.documentId,
          name: event.payload.name,
          entityTypes: event.payload.entityTypes || [],
          content: content.toString('utf-8'),
          format: event.payload.format,
          contentChecksum: event.payload.contentChecksum,
          creator: didToAgent(event.userId),
          creationMethod: 'api',
        });
        break;
      }

      case 'document.cloned': {
        const storage = getStorageService();
        const content = await storage.getDocument(event.documentId);
        await graphDb.createDocument({
          id: event.documentId,
          name: event.payload.name,
          entityTypes: event.payload.entityTypes || [],
          content: content.toString('utf-8'),
          format: event.payload.format,
          contentChecksum: event.payload.contentChecksum,
          creator: didToAgent(event.userId),
          creationMethod: 'clone',
        });
        break;
      }

      case 'document.archived':
        await graphDb.updateDocument(event.documentId, {
          archived: true,
        });
        break;

      case 'document.unarchived':
        await graphDb.updateDocument(event.documentId, {
          archived: false,
        });
        break;

      case 'annotation.added':
        await graphDb.createAnnotation({
          id: event.payload.annotationId,
          motivation: event.payload.motivation,
          target: {
            source: event.documentId,
            selector: {
              type: 'TextPositionSelector',
              exact: event.payload.exact,
              offset: event.payload.position.offset,
              length: event.payload.position.length,
            },
          },
          body: {
            type: event.payload.motivation === 'linking' ? 'SpecificResource' : 'TextualBody',
            entityTypes: event.payload.entityTypes || [],
            source: event.payload.targetDocumentId,
            value: event.payload.value,
          },
          creator: didToAgent(event.userId),
        });
        break;

      case 'annotation.removed':
        await graphDb.deleteAnnotation(event.payload.annotationId);
        break;

      case 'annotation.resolved':
        // TODO: Graph implementation should handle partial body updates properly
        try {
          await graphDb.updateAnnotation(event.payload.annotationId, {
            body: {
              type: 'SpecificResource',
              entityTypes: [],  // Graph impl should merge, not replace
              source: event.payload.targetDocumentId,
            },
          } as Partial<Annotation>);
        } catch (error) {
          // If annotation doesn't exist in graph (e.g., created before consumer started),
          // log warning but don't fail - event store is source of truth
          console.warn(`[GraphDBConsumer] Could not update annotation ${event.payload.annotationId} in graph: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        break;

      case 'entitytag.added':
        const doc = await graphDb.getDocument(event.documentId);
        if (doc) {
          await graphDb.updateDocument(event.documentId, {
            entityTypes: [...doc.entityTypes, event.payload.entityType],
          });
        }
        break;

      case 'entitytag.removed':
        const doc2 = await graphDb.getDocument(event.documentId);
        if (doc2) {
          await graphDb.updateDocument(event.documentId, {
            entityTypes: doc2.entityTypes.filter(t => t !== event.payload.entityType),
          });
        }
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
    const eventStore = await getEventStore();
    const events = await eventStore.getDocumentEvents(documentId);

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
    const eventStore = await getEventStore();
    const allDocumentIds = await eventStore.getAllDocumentIds();

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
  const eventStore = await getEventStore();

  // Get all existing document IDs
  const allDocumentIds = await eventStore.getAllDocumentIds();

  console.log(`[GraphDBConsumer] Starting consumer for ${allDocumentIds.length} documents`);

  // Subscribe to each document
  for (const documentId of allDocumentIds) {
    await consumer.subscribeToDocument(documentId);
  }

  console.log('[GraphDBConsumer] Consumer started');
}