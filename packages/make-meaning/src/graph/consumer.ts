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
import type { ResourceEvent, StoredEvent, EnvironmentConfig, ResourceId, Logger } from '@semiont/core';
import { resourceId as makeResourceId, findBodyItem } from '@semiont/core';
import { toResourceUri, toAnnotationUri } from '@semiont/event-sourcing';

type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export class GraphDBConsumer {
  // Event types that produce GraphDB mutations — filter everything else before processEvent()
  private static readonly GRAPH_RELEVANT_EVENTS = new Set([
    'resource.created', 'resource.archived', 'resource.unarchived',
    'annotation.added', 'annotation.removed', 'annotation.body.updated',
    'entitytag.added', 'entitytag.removed', 'entitytype.added',
  ]);

  private _globalSubscription: any = null;  // Global subscription (receives ALL events)
  private processing: Map<string, Promise<void>> = new Map();
  private lastProcessed: Map<string, number> = new Map();
  private readonly logger: Logger;

  constructor(
    private config: EnvironmentConfig,
    private eventStore: EventStore,
    private graphDb: GraphDatabase,
    logger: Logger
  ) {
    this.logger = logger;
  }

  async initialize() {
    this.logger.info('GraphDB consumer initialized');
    // Subscribe globally to receive ALL events (both system and resource events)
    await this.subscribeToGlobalEvents();
  }

  /**
   * Subscribe globally to ALL events (system AND resource events)
   * Resource events are now sent to global subscribers (see EventBus.publish)
   */
  private async subscribeToGlobalEvents() {
    this._globalSubscription = this.eventStore.bus.subscriptions.subscribeGlobal(async (storedEvent: StoredEvent) => {
      if (!GraphDBConsumer.GRAPH_RELEVANT_EVENTS.has(storedEvent.event.type)) return;
      await this.processEvent(storedEvent);
    });

    this.logger.info('Subscribed to global events (system + resource)');
  }

  private ensureInitialized(): GraphDatabase {
    return this.graphDb;
  }

  /**
   * Stop the consumer and unsubscribe from all events
   */
  async stop() {
    this.logger.info('Stopping GraphDB consumer');

    // Unsubscribe from global subscription
    if (this._globalSubscription && typeof this._globalSubscription.unsubscribe === 'function') {
      this._globalSubscription.unsubscribe();
    }
    this._globalSubscription = null;

    this.logger.info('GraphDB consumer stopped');
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
      this.logger.error('Failed to process event', { error });
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

    this.logger.debug('Applying event to GraphDB', {
      eventType: event.type,
      sequenceNumber: storedEvent.metadata.sequenceNumber
    });

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
        this.logger.debug('Creating resource in graph', { resourceUri });
        await graphDb.createResource(resource);
        this.logger.info('Resource created in graph', { resourceUri });
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
        this.logger.debug('Processing annotation.added event', {
          annotationId: event.payload.annotation.id
        });
        // Event payload contains Omit<Annotation, 'creator' | 'created'>
        // Add creator from event metadata (created not needed for graph)
        await graphDb.createAnnotation({
          ...event.payload.annotation,
          creator: didToAgent(event.userId),
        });
        this.logger.info('Annotation created in graph', {
          annotationId: event.payload.annotation.id
        });
        break;

      case 'annotation.removed':
        await graphDb.deleteAnnotation(toAnnotationUri({ baseUrl: this.config.services.backend!.publicURL }, event.payload.annotationId));
        break;

      case 'annotation.body.updated':
        this.logger.debug('Processing annotation.body.updated event', {
          annotationId: event.payload.annotationId,
          payload: event.payload
        });
        // Apply fine-grained body operations
        try {
          const annotationUri = toAnnotationUri({ baseUrl: this.config.services.backend!.publicURL }, event.payload.annotationId);
          this.logger.debug('Created annotation URI', { annotationUri });
          this.logger.debug('Processing body update', {
            annotationUri,
            operations: event.payload.operations
          });

          // Get current annotation from graph
          const currentAnnotation = await graphDb.getAnnotation(annotationUri);
          this.logger.debug('Current annotation lookup result', {
            found: !!currentAnnotation
          });

          if (currentAnnotation) {
            this.logger.debug('Current annotation body', { body: currentAnnotation.body });

            // Ensure body is an array
            let bodyArray = Array.isArray(currentAnnotation.body)
              ? [...currentAnnotation.body]
              : currentAnnotation.body
              ? [currentAnnotation.body]
              : [];

            // Apply each operation
            for (const op of event.payload.operations) {
              this.logger.debug('Applying body operation', { operation: op });
              if (op.op === 'add') {
                // Add item (idempotent - don't add if already exists)
                const exists = findBodyItem(bodyArray, op.item) !== -1;
                if (!exists) {
                  bodyArray.push(op.item);
                  this.logger.debug('Added item to body');
                } else {
                  this.logger.debug('Item already exists, skipping');
                }
              } else if (op.op === 'remove') {
                // Remove item
                const index = findBodyItem(bodyArray, op.item);
                if (index !== -1) {
                  bodyArray.splice(index, 1);
                  this.logger.debug('Removed item from body');
                }
              } else if (op.op === 'replace') {
                // Replace item
                const index = findBodyItem(bodyArray, op.oldItem);
                if (index !== -1) {
                  bodyArray[index] = op.newItem;
                  this.logger.debug('Replaced item in body');
                }
              }
            }

            this.logger.debug('New body array', { bodyArray });
            this.logger.debug('Calling updateAnnotation');

            // Update annotation with new body
            await graphDb.updateAnnotation(annotationUri, {
              body: bodyArray,
            } as Partial<Annotation>);

            this.logger.info('updateAnnotation completed successfully');
          } else {
            this.logger.warn('Annotation not found in graph, skipping update');
          }
        } catch (error) {
          // If annotation doesn't exist in graph (e.g., created before consumer started),
          // log warning but don't fail - event store is source of truth
          this.logger.error('Error in annotation.body.updated handler', {
            annotationId: event.payload.annotationId,
            error,
            stack: error instanceof Error ? error.stack : undefined
          });
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
        this.logger.warn('Unknown event type', { eventType: (event as ResourceEvent).type });
    }
  }

  /**
   * Rebuild entire resource from events
   * Useful for recovery or initial sync
   */
  async rebuildResource(resourceId: ResourceId): Promise<void> {
    const graphDb = this.ensureInitialized();
    this.logger.info('Rebuilding resource from events', { resourceId });

    // Delete existing data
    try {
      await graphDb.deleteResource(toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, makeResourceId(resourceId)));
    } catch (error) {
      // Resource might not exist yet
      this.logger.debug('No existing resource to delete', { resourceId });
    }

    // Replay all events
    const query = new EventQuery(this.eventStore.log.storage);
    const events = await query.getResourceEvents(resourceId);

    for (const storedEvent of events) {
      await this.applyEventToGraph(storedEvent);
    }

    this.logger.info('Resource rebuild complete', { resourceId, eventCount: events.length });
  }

  /**
   * Rebuild entire GraphDB from all events
   * Uses two-pass approach to ensure all resources exist before creating REFERENCES edges
   */
  async rebuildAll(): Promise<void> {
    const graphDb = this.ensureInitialized();
    this.logger.info('Rebuilding entire GraphDB from events');
    this.logger.info('Using two-pass approach: nodes first, then edges');

    // Clear database
    await graphDb.clearDatabase();

    // Get all resource IDs by scanning event shards
    const query = new EventQuery(this.eventStore.log.storage);
    const allResourceIds = await this.eventStore.log.getAllResourceIds();

    this.logger.info('Found resources to rebuild', { count: allResourceIds.length });

    // PASS 1: Create all nodes (resources and annotations)
    // Skip annotation.body.updated events to avoid creating REFERENCES edges
    this.logger.info('PASS 1: Creating all nodes (resources + annotations)');
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
    this.logger.info('Pass 1 complete - all nodes created');

    // PASS 2: Create all edges (REFERENCES relationships)
    // Process ONLY annotation.body.updated events
    this.logger.info('PASS 2: Creating all REFERENCES edges');
    for (const resourceId of allResourceIds) {
      const events = await query.getResourceEvents(makeResourceId(resourceId as string));

      for (const storedEvent of events) {
        // Process ONLY annotation.body.updated events
        if (storedEvent.event.type === 'annotation.body.updated') {
          await this.applyEventToGraph(storedEvent);
        }
      }
    }
    this.logger.info('Pass 2 complete - all edges created');

    this.logger.info('Rebuild complete');
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
   * Shutdown consumer
   */
  async shutdown(): Promise<void> {
    // Unsubscribe from global events
    if (this._globalSubscription) {
      this._globalSubscription.unsubscribe();
      this._globalSubscription = null;
      this.logger.info('Unsubscribed from global events');
    }

    // GraphDB disconnect is handled by MakeMeaningService.stop()
    this.logger.info('GraphDB consumer shut down');
  }
}