/**
 * GraphDB Consumer
 * Subscribes to resource events and updates GraphDB accordingly
 *
 * Makes GraphDB a projection of Event Store events (single source of truth)
 */

import { EventQuery, type EventStore } from '@semiont/event-sourcing';
import { didToAgent } from '@semiont/core';
import type { GraphDatabase } from '@semiont/graph';
import type { components } from '@semiont/core';
import type { ResourceEvent, StoredEvent, EnvironmentConfig, ResourceId } from '@semiont/core';
import { resourceId as makeResourceId, findBodyItem } from '@semiont/core';
import { toResourceUri, toAnnotationUri } from '@semiont/event-sourcing';

type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export class GraphDBConsumer {
  private _globalSubscription: any = null;  // Global subscription (receives ALL events)
  private processing: Map<string, Promise<void>> = new Map();
  private lastProcessed: Map<string, number> = new Map();

  constructor(
    private config: EnvironmentConfig,
    private eventStore: EventStore,
    private graphDb: GraphDatabase
  ) {}

  async initialize() {
    console.log('[GraphDBConsumer] Initialized');
    // Subscribe globally to receive ALL events (both system and resource events)
    await this.subscribeToGlobalEvents();
  }

  /**
   * Subscribe globally to ALL events (system AND resource events)
   * Resource events are now sent to global subscribers (see EventBus.publish)
   */
  private async subscribeToGlobalEvents() {
    this._globalSubscription = this.eventStore.bus.subscriptions.subscribeGlobal(async (storedEvent: StoredEvent) => {
      await this.processEvent(storedEvent);
    });

    console.log('[GraphDBConsumer] Subscribed to global events (system + resource)');
  }

  private ensureInitialized(): GraphDatabase {
    return this.graphDb;
  }

  /**
   * @deprecated No longer needed - GraphConsumer uses global subscription only
   * Kept for backward compatibility with existing code (e.g., rebuild-graph.ts)
   */
  async subscribeToResource(resourceId: ResourceId) {
    // No-op: Global subscription already receives all resource events
    console.log(`[GraphDBConsumer] subscribeToResource(${resourceId}) - no-op (using global subscription)`);
  }

  /**
   * Stop the consumer and unsubscribe from all events
   */
  async stop() {
    console.log('[GraphDBConsumer] Stopping...');

    // Unsubscribe from global subscription
    if (this._globalSubscription && typeof this._globalSubscription.unsubscribe === 'function') {
      this._globalSubscription.unsubscribe();
    }
    this._globalSubscription = null;

    console.log('[GraphDBConsumer] Stopped');
  }

  /**
   * Process event with ordering guarantee (sequential per resource)
   */
  protected async processEvent(storedEvent: StoredEvent): Promise<void> {
    const { resourceId } = storedEvent.event;

    // ⚠️ BRITTLE: System-level events (entitytype.added) have no resourceId
    // Process these immediately without ordering guarantees
    if (!resourceId) {
      await this.applyEventToGraph(storedEvent);
      return;
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
   * Apply event to GraphDB
   */
  protected async applyEventToGraph(storedEvent: StoredEvent): Promise<void> {
    const graphDb = this.ensureInitialized();
    const event = storedEvent.event;

    console.log(`[GraphDBConsumer] Applying ${event.type} to GraphDB (seq=${storedEvent.metadata.sequenceNumber})`);

    switch (event.type) {
      case 'resource.created': {
        if (!event.resourceId) throw new Error('resource.created requires resourceId');
        const resourceUri = toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, event.resourceId);
        const resource: ResourceDescriptor = {
          '@context': 'https://schema.org/',
          '@id': resourceUri,
          name: event.payload.name,
          entityTypes: event.payload.entityTypes || [],
          representations: [{
            mediaType: event.payload.format,
            checksum: event.payload.contentChecksum,
            rel: 'original',
          }],
          archived: false,
          dateCreated: new Date().toISOString(),
          wasAttributedTo: didToAgent(event.userId),
          creationMethod: event.payload.creationMethod,
        };
        console.log(`[GraphDBConsumer] Creating resource in graph: ${resourceUri}`);
        await graphDb.createResource(resource);
        console.log(`[GraphDBConsumer] ✅ Resource created in graph: ${resourceUri}`);
        break;
      }

      case 'resource.archived':
        if (!event.resourceId) throw new Error('resource.archived requires resourceId');
        await graphDb.updateResource(toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, event.resourceId), {
          archived: true,
        });
        break;

      case 'resource.unarchived':
        if (!event.resourceId) throw new Error('resource.unarchived requires resourceId');
        await graphDb.updateResource(toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, event.resourceId), {
          archived: false,
        });
        break;

      case 'annotation.added':
        console.log(`[GraphDBConsumer] 🔍 ENTERED annotation.added case block`);
        console.log(`[GraphDBConsumer] Annotation ID: ${event.payload.annotation.id}`);
        // Event payload contains Omit<Annotation, 'creator' | 'created'>
        // Add creator from event metadata (created not needed for graph)
        await graphDb.createAnnotation({
          ...event.payload.annotation,
          creator: didToAgent(event.userId),
        });
        console.log(`[GraphDBConsumer] ✅ Annotation created in graph: ${event.payload.annotation.id}`);
        break;

      case 'annotation.removed':
        await graphDb.deleteAnnotation(toAnnotationUri({ baseUrl: this.config.services.backend!.publicURL }, event.payload.annotationId));
        break;

      case 'annotation.body.updated':
        console.log(`[GraphDBConsumer] 🔍 ENTERED annotation.body.updated case block`);
        console.log(`[GraphDBConsumer] Event payload:`, JSON.stringify(event.payload));
        // Apply fine-grained body operations
        try {
          console.log(`[GraphDBConsumer] Creating annotation URI for: ${event.payload.annotationId}`);
          const annotationUri = toAnnotationUri({ baseUrl: this.config.services.backend!.publicURL }, event.payload.annotationId);
          console.log(`[GraphDBConsumer] ✅ Annotation URI created: ${annotationUri}`);
          console.log(`[GraphDBConsumer] Processing annotation.body.updated for ${annotationUri}`);
          console.log(`[GraphDBConsumer] Operations:`, JSON.stringify(event.payload.operations));

          // Get current annotation from graph
          const currentAnnotation = await graphDb.getAnnotation(annotationUri);
          console.log(`[GraphDBConsumer] Current annotation in graph:`, currentAnnotation ? 'FOUND' : 'NOT FOUND');

          if (currentAnnotation) {
            console.log(`[GraphDBConsumer] Current body:`, JSON.stringify(currentAnnotation.body));

            // Ensure body is an array
            let bodyArray = Array.isArray(currentAnnotation.body)
              ? [...currentAnnotation.body]
              : currentAnnotation.body
              ? [currentAnnotation.body]
              : [];

            // Apply each operation
            for (const op of event.payload.operations) {
              console.log(`[GraphDBConsumer] Applying operation:`, JSON.stringify(op));
              if (op.op === 'add') {
                // Add item (idempotent - don't add if already exists)
                const exists = findBodyItem(bodyArray, op.item) !== -1;
                if (!exists) {
                  bodyArray.push(op.item);
                  console.log(`[GraphDBConsumer] Added item to body`);
                } else {
                  console.log(`[GraphDBConsumer] Item already exists, skipping`);
                }
              } else if (op.op === 'remove') {
                // Remove item
                const index = findBodyItem(bodyArray, op.item);
                if (index !== -1) {
                  bodyArray.splice(index, 1);
                  console.log(`[GraphDBConsumer] Removed item from body`);
                }
              } else if (op.op === 'replace') {
                // Replace item
                const index = findBodyItem(bodyArray, op.oldItem);
                if (index !== -1) {
                  bodyArray[index] = op.newItem;
                  console.log(`[GraphDBConsumer] Replaced item in body`);
                }
              }
            }

            console.log(`[GraphDBConsumer] New body array:`, JSON.stringify(bodyArray));
            console.log(`[GraphDBConsumer] Calling updateAnnotation...`);

            // Update annotation with new body
            await graphDb.updateAnnotation(annotationUri, {
              body: bodyArray,
            } as Partial<Annotation>);

            console.log(`[GraphDBConsumer] ✅ updateAnnotation completed successfully`);
          } else {
            console.log(`[GraphDBConsumer] ⚠️  Annotation not found in graph, skipping update`);
          }
        } catch (error) {
          // If annotation doesn't exist in graph (e.g., created before consumer started),
          // log warning but don't fail - event store is source of truth
          console.error(`[GraphDBConsumer] ❌ ERROR in annotation.body.updated handler`);
          console.error(`[GraphDBConsumer] Annotation ID: ${event.payload.annotationId}`);
          console.error(`[GraphDBConsumer] Error:`, error);
          console.error(`[GraphDBConsumer] Error stack:`, error instanceof Error ? error.stack : 'N/A');
        }
        break;

      case 'entitytag.added':
        if (!event.resourceId) throw new Error('entitytag.added requires resourceId');
        const doc = await graphDb.getResource(toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, event.resourceId));
        if (doc) {
          await graphDb.updateResource(toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, event.resourceId), {
            entityTypes: [...(doc.entityTypes || []), event.payload.entityType],
          });
        }
        break;

      case 'entitytag.removed':
        if (!event.resourceId) throw new Error('entitytag.removed requires resourceId');
        const doc2 = await graphDb.getResource(toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, event.resourceId));
        if (doc2) {
          await graphDb.updateResource(toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, event.resourceId), {
            entityTypes: (doc2.entityTypes || []).filter(t => t !== event.payload.entityType),
          });
        }
        break;

      case 'entitytype.added':
        // ⚠️ BRITTLE: Event routing depends on absence of resourceId
        // This handler is called for system-level events (global entity type collection)
        // TODO: Design cleaner event routing with explicit projection targets
        await graphDb.addEntityType(event.payload.entityType);
        break;

      default:
        console.warn(`[GraphDBConsumer] Unknown event type: ${(event as ResourceEvent).type}`);
    }
  }

  /**
   * Rebuild entire resource from events
   * Useful for recovery or initial sync
   */
  async rebuildResource(resourceId: ResourceId): Promise<void> {
    const graphDb = this.ensureInitialized();
    console.log(`[GraphDBConsumer] Rebuilding resource ${resourceId} from events`);

    // Delete existing data
    try {
      await graphDb.deleteResource(toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, makeResourceId(resourceId)));
    } catch (error) {
      // Resource might not exist yet
      console.log(`[GraphDBConsumer] No existing resource to delete: ${resourceId}`);
    }

    // Replay all events
    const query = new EventQuery(this.eventStore.log.storage);
    const events = await query.getResourceEvents(resourceId);

    for (const storedEvent of events) {
      await this.applyEventToGraph(storedEvent);
    }

    console.log(`[GraphDBConsumer] Rebuilt ${resourceId} from ${events.length} events`);
  }

  /**
   * Rebuild entire GraphDB from all events
   * Uses two-pass approach to ensure all resources exist before creating REFERENCES edges
   */
  async rebuildAll(): Promise<void> {
    const graphDb = this.ensureInitialized();
    console.log('[GraphDBConsumer] Rebuilding entire GraphDB from events...');
    console.log('[GraphDBConsumer] Using two-pass approach: nodes first, then edges\n');

    // Clear database
    await graphDb.clearDatabase();

    // Get all resource IDs by scanning event shards
    const query = new EventQuery(this.eventStore.log.storage);
    const allResourceIds = await this.eventStore.log.getAllResourceIds();

    console.log(`[GraphDBConsumer] Found ${allResourceIds.length} resources to rebuild`);

    // PASS 1: Create all nodes (resources and annotations)
    // Skip annotation.body.updated events to avoid creating REFERENCES edges
    console.log('\n[GraphDBConsumer] === PASS 1: Creating all nodes (resources + annotations) ===');
    for (const resourceId of allResourceIds) {
      const events = await query.getResourceEvents(makeResourceId(resourceId as string));

      for (const storedEvent of events) {
        // Skip annotation.body.updated - we'll process these in pass 2
        if (storedEvent.event.type === 'annotation.body.updated') {
          continue;
        }
        await this.applyEventToGraph(storedEvent);
      }
    }
    console.log('[GraphDBConsumer] ✅ Pass 1 complete - all nodes created\n');

    // PASS 2: Create all edges (REFERENCES relationships)
    // Process ONLY annotation.body.updated events
    console.log('[GraphDBConsumer] === PASS 2: Creating all REFERENCES edges ===');
    for (const resourceId of allResourceIds) {
      const events = await query.getResourceEvents(makeResourceId(resourceId as string));

      for (const storedEvent of events) {
        // Process ONLY annotation.body.updated events
        if (storedEvent.event.type === 'annotation.body.updated') {
          await this.applyEventToGraph(storedEvent);
        }
      }
    }
    console.log('[GraphDBConsumer] ✅ Pass 2 complete - all edges created\n');

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
      subscriptions: this._globalSubscription ? 1 : 0, // Only global subscription
      lastProcessed: Object.fromEntries(this.lastProcessed),
      processing: Array.from(this.processing.keys()),
    };
  }

  /**
   * @deprecated No longer needed - GraphConsumer uses global subscription only
   */
  async unsubscribeFromResource(resourceId: ResourceId): Promise<void> {
    // No-op: Using global subscription, can't unsubscribe from individual resources
    console.log(`[GraphDBConsumer] unsubscribeFromResource(${resourceId}) - no-op (using global subscription)`);
  }

  /**
   * @deprecated No longer needed - GraphConsumer uses global subscription only
   * Use stop() instead
   */
  async unsubscribeAll(): Promise<void> {
    console.log('[GraphDBConsumer] unsubscribeAll() - no-op (use stop() instead)');
  }

  /**
   * Shutdown consumer
   */
  async shutdown(): Promise<void> {
    // Unsubscribe from global events
    if (this._globalSubscription) {
      this._globalSubscription.unsubscribe();
      this._globalSubscription = null;
      console.log('[GraphDBConsumer] Unsubscribed from global events');
    }

    // GraphDB disconnect is handled by MakeMeaningService.stop()
    console.log('[GraphDBConsumer] Shut down');
  }
}