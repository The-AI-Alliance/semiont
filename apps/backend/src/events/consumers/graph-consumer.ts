/**
 * GraphDB Consumer
 * Subscribes to resource events and updates GraphDB accordingly
 *
 * Makes GraphDB a projection of Layer 2 events (single source of truth)
 */

import { createEventStore, createEventQuery } from '../../services/event-store-service';
import { getGraphDatabase } from '../../graph/factory';
import { didToAgent } from '../../utils/id-generator';
import type { GraphDatabase } from '../../graph/interface';
import type { components } from '@semiont/api-client';
import type { ResourceEvent, StoredEvent, CreationMethod } from '@semiont/core';
import { findBodyItem, isSystemEvent } from '@semiont/core';
import { getFilesystemConfig, getBackendConfig } from '../../config/environment-loader';
import type { EventSubscription } from '../subscriptions/event-subscriptions';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export class GraphDBConsumer {
  private graphDb: GraphDatabase | null = null;
  private subscriptions: Map<string, EventSubscription> = new Map();
  private _globalSubscription: EventSubscription | null = null;  // Subscription to system-level events (kept for cleanup)
  private processing: Map<string, Promise<void>> = new Map();
  private lastProcessed: Map<string, number> = new Map();
  private backendURL: string | null = null;

  async initialize() {
    if (!this.graphDb) {
      this.graphDb = await getGraphDatabase();
      this.backendURL = getBackendConfig().publicURL;
      console.log('[GraphDBConsumer] Initialized');

      // Subscribe to global system-level events
      await this.subscribeToGlobalEvents();
    }
  }

  /**
   * Subscribe to global system-level events (no resourceId)
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
    if (!this.graphDb || !this.backendURL) {
      throw new Error('GraphDBConsumer not initialized. Call initialize() first.');
    }
    return this.graphDb;
  }

  /**
   * Subscribe to events for a resource
   * Apply each event to GraphDB
   */
  async subscribeToResource(resourceId: string) {
    this.ensureInitialized();
    const basePath = getFilesystemConfig().path;
    const eventStore = await createEventStore(basePath);

    // Construct full resource URI for subscription (events are published with full URIs)
    const resourceUri = resourceId.includes('/')
      ? resourceId  // Already a full URI
      : `${this.backendURL}/resources/${resourceId}`;  // Construct from short ID

    const subscription = eventStore.subscriptions.subscribe(resourceUri, async (storedEvent) => {
      await this.processEvent(storedEvent);
    });

    this.subscriptions.set(resourceUri, subscription);
    console.log(`[GraphDBConsumer] Subscribed to ${resourceUri}`);
  }

  /**
   * Process event with ordering guarantee (sequential per resource)
   */
  protected async processEvent(storedEvent: StoredEvent): Promise<void> {
    // System-level events have no resource scope - process immediately
    if (isSystemEvent(storedEvent.event)) {
      await this.applyEventToGraph(storedEvent);
      return;
    }

    // Resource-scoped events require sequential processing per resource
    const resourceId = storedEvent.event.resourceId;
    if (!resourceId) {
      throw new Error(`Resource-scoped event ${storedEvent.event.type} missing resourceId`);
    }

    // Wait for previous event on this resource to complete
    const previousProcessing = this.processing.get(resourceId);
    if (previousProcessing) {
      await previousProcessing;
    }

    // Create new processing promise
    const processingPromise = this.applyEventToGraph(storedEvent);
    this.processing.set(resourceId, processingPromise);

    try {
      await processingPromise;
      this.lastProcessed.set(resourceId, storedEvent.metadata.sequenceNumber);
    } catch (error) {
      console.error(`[GraphDBConsumer] Failed to process event:`, error);
      throw error;
    } finally {
      this.processing.delete(resourceId);
    }
  }

  /**
   * Build ResourceDescriptor from resource creation/clone event
   */
  private buildResourceDescriptor(
    resourceId: string,
    payload: { name: string; format: string; contentChecksum: string; creationMethod: CreationMethod; entityTypes?: string[] },
    userId: string
  ): ResourceDescriptor {
    return {
      '@context': 'https://schema.org/',
      '@id': `${this.backendURL}/resources/${resourceId}`,
      name: payload.name,
      entityTypes: payload.entityTypes || [],
      representations: [{
        mediaType: payload.format,
        checksum: payload.contentChecksum,
        rel: 'original',
      }],
      archived: false,
      dateCreated: new Date().toISOString(),
      wasAttributedTo: didToAgent(userId),
      creationMethod: payload.creationMethod,
    };
  }

  /**
   * Event Handlers - Each handler processes one event type
   */

  private async handleResourceCreated(graphDb: GraphDatabase, event: StoredEvent['event']): Promise<void> {
    if (event.type !== 'resource.created') return;
    if (!event.resourceId) throw new Error('resource.created requires resourceId');
    const resource = this.buildResourceDescriptor(event.resourceId, event.payload, event.userId);
    await graphDb.createResource(resource);
  }

  private async handleResourceCloned(graphDb: GraphDatabase, event: StoredEvent['event']): Promise<void> {
    if (event.type !== 'resource.cloned') return;
    if (!event.resourceId) throw new Error('resource.cloned requires resourceId');
    const resource = this.buildResourceDescriptor(event.resourceId, event.payload, event.userId);
    await graphDb.createResource(resource);
  }

  private async handleResourceArchived(graphDb: GraphDatabase, event: StoredEvent['event']): Promise<void> {
    if (event.type !== 'resource.archived') return;
    if (!event.resourceId) throw new Error('resource.archived requires resourceId');
    await graphDb.updateResource(event.resourceId, {
      archived: true,
    });
  }

  private async handleResourceUnarchived(graphDb: GraphDatabase, event: StoredEvent['event']): Promise<void> {
    if (event.type !== 'resource.unarchived') return;
    if (!event.resourceId) throw new Error('resource.unarchived requires resourceId');
    await graphDb.updateResource(event.resourceId, {
      archived: false,
    });
  }

  private async handleAnnotationAdded(graphDb: GraphDatabase, event: StoredEvent['event']): Promise<void> {
    if (event.type !== 'annotation.added') return;
    // Event payload contains Omit<Annotation, 'creator' | 'created'>
    // Add creator from event metadata (created not needed for graph)
    await graphDb.createAnnotation({
      ...event.payload.annotation,
      creator: didToAgent(event.userId),
    });
  }

  private async handleAnnotationRemoved(graphDb: GraphDatabase, event: StoredEvent['event']): Promise<void> {
    if (event.type !== 'annotation.removed') return;
    await graphDb.deleteAnnotation(event.payload.annotationId);
  }

  private async handleAnnotationBodyUpdated(graphDb: GraphDatabase, event: StoredEvent['event']): Promise<void> {
    if (event.type !== 'annotation.body.updated') return;

    // Apply fine-grained body operations
    try {
      // Get current annotation from graph
      console.log(`[GraphDBConsumer] handleAnnotationBodyUpdated for ${event.payload.annotationId}`);
      const currentAnnotation = await graphDb.getAnnotation(event.payload.annotationId);
      if (currentAnnotation) {
        console.log(`[GraphDBConsumer] Found annotation in Neo4j, applying ${event.payload.operations.length} operations`);
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

        console.log(`[GraphDBConsumer] Calling updateAnnotation with body:`, JSON.stringify(bodyArray));
        // Update annotation with new body
        await graphDb.updateAnnotation(event.payload.annotationId, {
          body: bodyArray,
        });
      } else {
        console.warn(`[GraphDBConsumer] Annotation ${event.payload.annotationId} not found in Neo4j - cannot update body. Annotation may have been created before GraphDBConsumer started.`);
      }
    } catch (error) {
      // If annotation doesn't exist in graph (e.g., created before consumer started),
      // log error but don't fail - event store is source of truth
      console.error(
        `[GraphDBConsumer] Failed to update annotation body for ${event.payload.annotationId}:`,
        error instanceof Error ? error.message : String(error),
        '\nFull error:',
        error
      );
    }
  }

  private async handleEntityTagAdded(graphDb: GraphDatabase, event: StoredEvent['event']): Promise<void> {
    if (event.type !== 'entitytag.added') return;
    if (!event.resourceId) throw new Error('entitytag.added requires resourceId');
    const existingResource = await graphDb.getResource(event.resourceId);
    if (existingResource) {
      await graphDb.updateResource(event.resourceId, {
        entityTypes: [...(existingResource.entityTypes || []), event.payload.entityType],
      });
    }
  }

  private async handleEntityTagRemoved(graphDb: GraphDatabase, event: StoredEvent['event']): Promise<void> {
    if (event.type !== 'entitytag.removed') return;
    if (!event.resourceId) throw new Error('entitytag.removed requires resourceId');
    const existingResource = await graphDb.getResource(event.resourceId);
    if (existingResource) {
      await graphDb.updateResource(event.resourceId, {
        entityTypes: (existingResource.entityTypes || []).filter(t => t !== event.payload.entityType),
      });
    }
  }

  private async handleEntityTypeAdded(graphDb: GraphDatabase, event: StoredEvent['event']): Promise<void> {
    if (event.type !== 'entitytype.added') return;
    // System-level event: Update global entity type collection
    await graphDb.addEntityType(event.payload.entityType);
  }

  /**
   * Apply event to GraphDB
   * Routes events to specific handlers
   */
  protected async applyEventToGraph(storedEvent: StoredEvent): Promise<void> {
    const graphDb = this.ensureInitialized();
    const event = storedEvent.event;

    console.log(`[GraphDBConsumer] Applying ${event.type} to GraphDB (seq=${storedEvent.metadata.sequenceNumber})`);

    switch (event.type) {
      case 'resource.created':
        return this.handleResourceCreated(graphDb, event);
      case 'resource.cloned':
        return this.handleResourceCloned(graphDb, event);
      case 'resource.archived':
        return this.handleResourceArchived(graphDb, event);
      case 'resource.unarchived':
        return this.handleResourceUnarchived(graphDb, event);
      case 'annotation.added':
        return this.handleAnnotationAdded(graphDb, event);
      case 'annotation.removed':
        return this.handleAnnotationRemoved(graphDb, event);
      case 'annotation.body.updated':
        return this.handleAnnotationBodyUpdated(graphDb, event);
      case 'entitytag.added':
        return this.handleEntityTagAdded(graphDb, event);
      case 'entitytag.removed':
        return this.handleEntityTagRemoved(graphDb, event);
      case 'entitytype.added':
        return this.handleEntityTypeAdded(graphDb, event);
      case 'job.started':
      case 'job.progress':
      case 'job.completed':
      case 'job.failed':
        // Job events don't need to update the graph database
        return;
      default:
        console.warn(`[GraphDBConsumer] Unknown event type: ${(event as ResourceEvent).type}`);
    }
  }

  /**
   * Rebuild entire resource from events
   * Useful for recovery or initial sync
   */
  async rebuildResource(resourceId: string): Promise<void> {
    const graphDb = this.ensureInitialized();
    console.log(`[GraphDBConsumer] Rebuilding resource ${resourceId} from events`);

    // Delete existing data
    try {
      await graphDb.deleteResource(resourceId);
    } catch (error) {
      // Resource might not exist yet
      console.log(`[GraphDBConsumer] No existing resource to delete: ${resourceId}`);
    }

    // Replay all events
    const basePath = getFilesystemConfig().path;
    const eventStore = await createEventStore(basePath);
    const query = createEventQuery(eventStore);
    const events = await query.getResourceEvents(resourceId);

    for (const storedEvent of events) {
      await this.applyEventToGraph(storedEvent);
    }

    console.log(`[GraphDBConsumer] Rebuilt ${resourceId} from ${events.length} events`);
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

    // Get all resource IDs by scanning event shards
    const basePath = getFilesystemConfig().path;
    const eventStore = await createEventStore(basePath);
    const allResourceIds = await eventStore.storage.getAllResourceIds();

    console.log(`[GraphDBConsumer] Found ${allResourceIds.length} resources to rebuild`);

    for (const resourceId of allResourceIds) {
      await this.rebuildResource(resourceId);
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
   * Unsubscribe from resource
   */
  async unsubscribeFromResource(resourceId: string): Promise<void> {
    const subscription = this.subscriptions.get(resourceId);
    if (subscription) {
      subscription.unsubscribe();
      this.subscriptions.delete(resourceId);
      console.log(`[GraphDBConsumer] Unsubscribed from ${resourceId}`);
    }
  }

  /**
   * Unsubscribe from all resources
   */
  async unsubscribeAll(): Promise<void> {
    for (const subscription of this.subscriptions.values()) {
      subscription.unsubscribe();
    }
    this.subscriptions.clear();
    console.log('[GraphDBConsumer] Unsubscribed from all resources');
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
 * Start consumer for existing resources
 * Called on app initialization
 */
export async function startGraphConsumer(): Promise<void> {
  const consumer = await getGraphConsumer();
  const basePath = getFilesystemConfig().path;
  const eventStore = await createEventStore(basePath);

  // Get all existing resource IDs
  const allResourceIds = await eventStore.storage.getAllResourceIds();

  console.log(`[GraphDBConsumer] Starting consumer for ${allResourceIds.length} resources`);

  // Subscribe to each resource
  for (const resourceId of allResourceIds) {
    await consumer.subscribeToResource(resourceId);
  }

  console.log('[GraphDBConsumer] Consumer started');
}