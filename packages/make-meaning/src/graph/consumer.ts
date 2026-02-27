/**
 * GraphDB Consumer
 *
 * Subscribes to resource events and updates GraphDB accordingly.
 * Makes GraphDB a projection of Event Store events (single source of truth).
 *
 * Uses an RxJS pipeline with adaptive burst buffering:
 *   - First event after idle passes through immediately (zero latency)
 *   - Subsequent events in a burst are batched and flushed together
 *   - After idle, returns to passthrough mode
 *
 * Per-resource ordering is preserved via groupBy(resourceId) + concatMap.
 * Cross-resource parallelism is provided via mergeMap over groups.
 *
 * Burst buffer thresholds (see BATCH-GRAPH-CONSUMER-RX.md for tuning guidance):
 *   BURST_WINDOW_MS  = 50   — debounce window before flushing a batch
 *   MAX_BATCH_SIZE   = 500  — force flush to bound memory
 *   IDLE_TIMEOUT_MS  = 200  — silence before returning to passthrough
 */

import { Subject, Subscription, from } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import { EventQuery, type EventStore } from '@semiont/event-sourcing';
import { didToAgent, burstBuffer } from '@semiont/core';
import type { GraphDatabase } from '@semiont/graph';
import type { components } from '@semiont/core';
import type { ResourceEvent, StoredEvent, AnnotationAddedEvent, EnvironmentConfig, ResourceId, Logger } from '@semiont/core';
import { resourceId as makeResourceId, findBodyItem } from '@semiont/core';
import { toResourceUri, toAnnotationUri } from '@semiont/event-sourcing';

type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export class GraphDBConsumer {
  // Event types that produce GraphDB mutations — filter everything else
  private static readonly GRAPH_RELEVANT_EVENTS = new Set([
    'resource.created', 'resource.archived', 'resource.unarchived',
    'annotation.added', 'annotation.removed', 'annotation.body.updated',
    'entitytag.added', 'entitytag.removed', 'entitytype.added',
  ]);

  // Burst buffer thresholds — see class doc and BATCH-GRAPH-CONSUMER-RX.md
  private static readonly BURST_WINDOW_MS = 50;
  private static readonly MAX_BATCH_SIZE = 500;
  private static readonly IDLE_TIMEOUT_MS = 200;

  private _globalSubscription: any = null;
  private eventSubject = new Subject<StoredEvent>();
  private pipelineSubscription: Subscription | null = null;
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
    await this.subscribeToGlobalEvents();
  }

  /**
   * Subscribe globally to ALL events, pre-filter to graph-relevant types,
   * and wire through the RxJS burst-buffered pipeline.
   */
  private async subscribeToGlobalEvents() {
    // Bridge: callback-based EventBus subscription → RxJS Subject
    this._globalSubscription = this.eventStore.bus.subscriptions.subscribeGlobal(
      (storedEvent: StoredEvent) => {
        if (!GraphDBConsumer.GRAPH_RELEVANT_EVENTS.has(storedEvent.event.type)) return;
        this.eventSubject.next(storedEvent);
      }
    );

    // Build the RxJS pipeline
    this.pipelineSubscription = this.eventSubject.pipe(
      // Split into one inner Observable per resource (system events grouped under '__system__')
      groupBy((se: StoredEvent) => se.event.resourceId ?? '__system__'),

      mergeMap((group) => {
        if (group.key === '__system__') {
          // System events (e.g., entitytype.added): process immediately, sequentially
          return group.pipe(
            concatMap((se) => from(this.safeApplyEvent(se)))
          );
        }

        // Resource events: apply burst buffering per resource group
        return group.pipe(
          burstBuffer<StoredEvent>({
            burstWindowMs: GraphDBConsumer.BURST_WINDOW_MS,
            maxBatchSize: GraphDBConsumer.MAX_BATCH_SIZE,
            idleTimeoutMs: GraphDBConsumer.IDLE_TIMEOUT_MS,
          }),
          concatMap((eventOrBatch: StoredEvent | StoredEvent[]) => {
            if (Array.isArray(eventOrBatch)) {
              return from(this.processBatch(eventOrBatch));
            }
            return from(this.safeApplyEvent(eventOrBatch).then(() => {
              this.lastProcessed.set(
                eventOrBatch.event.resourceId!,
                eventOrBatch.metadata.sequenceNumber
              );
            }));
          })
        );
      })
    ).subscribe({
      error: (err) => {
        this.logger.error('GraphDB consumer pipeline error', { error: err });
      }
    });

    this.logger.info('Subscribed to global events with burst-buffered pipeline');
  }

  /**
   * Wrap applyEventToGraph in try/catch so one failed event doesn't kill the pipeline.
   */
  private async safeApplyEvent(storedEvent: StoredEvent): Promise<void> {
    try {
      await this.applyEventToGraph(storedEvent);
    } catch (error) {
      this.logger.error('Failed to apply event to graph', {
        eventType: storedEvent.event.type,
        resourceId: storedEvent.event.resourceId,
        error,
      });
    }
  }

  private ensureInitialized(): GraphDatabase {
    return this.graphDb;
  }

  /**
   * Stop the consumer, flush remaining buffered events, and unsubscribe.
   */
  async stop() {
    this.logger.info('Stopping GraphDB consumer');

    // Unsubscribe from event source (stops feeding the Subject)
    if (this._globalSubscription && typeof this._globalSubscription.unsubscribe === 'function') {
      this._globalSubscription.unsubscribe();
    }
    this._globalSubscription = null;

    // Complete the Subject — this triggers burst buffer flush of remaining events
    this.eventSubject.complete();

    // Unsubscribe from the pipeline
    if (this.pipelineSubscription) {
      this.pipelineSubscription.unsubscribe();
      this.pipelineSubscription = null;
    }

    // Create a fresh Subject for potential re-initialization
    this.eventSubject = new Subject<StoredEvent>();

    this.logger.info('GraphDB consumer stopped');
  }

  /**
   * Process a batch of events for the same resource.
   * Partitions into consecutive same-type runs for batch optimization.
   */
  private async processBatch(events: StoredEvent[]): Promise<void> {
    // Partition into runs of consecutive same-type events
    const runs: StoredEvent[][] = [];
    let currentRun: StoredEvent[] = [];

    for (const event of events) {
      if (currentRun.length > 0 && currentRun[0].event.type !== event.event.type) {
        runs.push(currentRun);
        currentRun = [];
      }
      currentRun.push(event);
    }
    if (currentRun.length > 0) runs.push(currentRun);

    for (const run of runs) {
      try {
        if (run.length === 1) {
          await this.applyEventToGraph(run[0]);
        } else {
          await this.applyBatchByType(run);
        }
      } catch (error) {
        this.logger.error('Failed to process batch run', {
          eventType: run[0].event.type,
          runSize: run.length,
          error,
        });
      }
      const last = run[run.length - 1];
      if (last.event.resourceId) {
        this.lastProcessed.set(last.event.resourceId, last.metadata.sequenceNumber);
      }
    }

    this.logger.debug('Processed batch', {
      resourceId: events[0]?.event.resourceId,
      batchSize: events.length,
    });
  }

  /**
   * Batch-optimized processing for consecutive events of the same type.
   * Uses batch graph methods where available, falls back to sequential.
   */
  private async applyBatchByType(events: StoredEvent[]): Promise<void> {
    const graphDb = this.ensureInitialized();
    const type = events[0].event.type;

    switch (type) {
      case 'resource.created': {
        const resources = events.map(e => this.buildResourceDescriptor(e));
        await graphDb.batchCreateResources(resources);
        this.logger.info('Batch created resources in graph', { count: events.length });
        break;
      }
      case 'annotation.added': {
        const inputs = events.map(e => {
          const event = e.event as AnnotationAddedEvent;
          return {
            ...event.payload.annotation,
            creator: didToAgent(event.userId),
          };
        });
        await graphDb.createAnnotations(inputs);
        this.logger.info('Batch created annotations in graph', { count: events.length });
        break;
      }
      default:
        // For types without batch optimization, fall back to sequential
        for (const event of events) {
          await this.applyEventToGraph(event);
        }
    }
  }

  /**
   * Build a ResourceDescriptor from a resource.created event.
   * Extracted for reuse by both applyEventToGraph and applyBatchByType.
   */
  private buildResourceDescriptor(storedEvent: StoredEvent): ResourceDescriptor {
    const event = storedEvent.event;
    if (event.type !== 'resource.created') {
      throw new Error('Expected resource.created event');
    }
    if (!event.resourceId) {
      throw new Error('resource.created requires resourceId');
    }

    const resourceUri = toResourceUri(
      { baseUrl: this.config.services.backend!.publicURL },
      event.resourceId
    );

    return {
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
  }

  /**
   * Apply a single event to GraphDB.
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
        const resource = this.buildResourceDescriptor(storedEvent);
        this.logger.debug('Creating resource in graph', { resourceUri: resource['@id'] });
        await graphDb.createResource(resource);
        this.logger.info('Resource created in graph', { resourceUri: resource['@id'] });
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
        try {
          const annotationUri = toAnnotationUri({ baseUrl: this.config.services.backend!.publicURL }, event.payload.annotationId);

          const currentAnnotation = await graphDb.getAnnotation(annotationUri);

          if (currentAnnotation) {
            let bodyArray = Array.isArray(currentAnnotation.body)
              ? [...currentAnnotation.body]
              : currentAnnotation.body
              ? [currentAnnotation.body]
              : [];

            for (const op of event.payload.operations) {
              if (op.op === 'add') {
                const exists = findBodyItem(bodyArray, op.item) !== -1;
                if (!exists) {
                  bodyArray.push(op.item);
                }
              } else if (op.op === 'remove') {
                const index = findBodyItem(bodyArray, op.item);
                if (index !== -1) {
                  bodyArray.splice(index, 1);
                }
              } else if (op.op === 'replace') {
                const index = findBodyItem(bodyArray, op.oldItem);
                if (index !== -1) {
                  bodyArray[index] = op.newItem;
                }
              }
            }

            await graphDb.updateAnnotation(annotationUri, {
              body: bodyArray,
            } as Partial<Annotation>);

            this.logger.info('updateAnnotation completed successfully');
          } else {
            this.logger.warn('Annotation not found in graph, skipping update');
          }
        } catch (error) {
          this.logger.error('Error in annotation.body.updated handler', {
            annotationId: event.payload.annotationId,
            error,
            stack: error instanceof Error ? error.stack : undefined
          });
        }
        break;

      case 'entitytag.added':
        if (!event.resourceId) throw new Error('entitytag.added requires resourceId');
        {
          const doc = await graphDb.getResource(toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, event.resourceId));
          if (doc) {
            await graphDb.updateResource(toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, event.resourceId), {
              entityTypes: [...(doc.entityTypes || []), event.payload.entityType],
            });
          }
        }
        break;

      case 'entitytag.removed':
        if (!event.resourceId) throw new Error('entitytag.removed requires resourceId');
        {
          const doc = await graphDb.getResource(toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, event.resourceId));
          if (doc) {
            await graphDb.updateResource(toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, event.resourceId), {
              entityTypes: (doc.entityTypes || []).filter(t => t !== event.payload.entityType),
            });
          }
        }
        break;

      case 'entitytype.added':
        await graphDb.addEntityType(event.payload.entityType);
        break;

      default:
        this.logger.warn('Unknown event type', { eventType: (event as ResourceEvent).type });
    }
  }

  /**
   * Rebuild entire resource from events.
   * Bypasses the live pipeline — reads directly from event store.
   */
  async rebuildResource(resourceId: ResourceId): Promise<void> {
    const graphDb = this.ensureInitialized();
    this.logger.info('Rebuilding resource from events', { resourceId });

    try {
      await graphDb.deleteResource(toResourceUri({ baseUrl: this.config.services.backend!.publicURL }, makeResourceId(resourceId)));
    } catch (error) {
      this.logger.debug('No existing resource to delete', { resourceId });
    }

    const query = new EventQuery(this.eventStore.log.storage);
    const events = await query.getResourceEvents(resourceId);

    for (const storedEvent of events) {
      await this.applyEventToGraph(storedEvent);
    }

    this.logger.info('Resource rebuild complete', { resourceId, eventCount: events.length });
  }

  /**
   * Rebuild entire GraphDB from all events.
   * Uses two-pass approach to ensure all resources exist before creating REFERENCES edges.
   * Bypasses the live pipeline — reads directly from event store.
   */
  async rebuildAll(): Promise<void> {
    const graphDb = this.ensureInitialized();
    this.logger.info('Rebuilding entire GraphDB from events');
    this.logger.info('Using two-pass approach: nodes first, then edges');

    await graphDb.clearDatabase();

    const query = new EventQuery(this.eventStore.log.storage);
    const allResourceIds = await this.eventStore.log.getAllResourceIds();

    this.logger.info('Found resources to rebuild', { count: allResourceIds.length });

    // PASS 1: Create all nodes (resources and annotations)
    this.logger.info('PASS 1: Creating all nodes (resources + annotations)');
    for (const resourceId of allResourceIds) {
      const events = await query.getResourceEvents(makeResourceId(resourceId as string));

      for (const storedEvent of events) {
        if (storedEvent.event.type === 'annotation.body.updated') {
          continue;
        }
        await this.applyEventToGraph(storedEvent);
      }
    }
    this.logger.info('Pass 1 complete - all nodes created');

    // PASS 2: Create all edges (REFERENCES relationships)
    this.logger.info('PASS 2: Creating all REFERENCES edges');
    for (const resourceId of allResourceIds) {
      const events = await query.getResourceEvents(makeResourceId(resourceId as string));

      for (const storedEvent of events) {
        if (storedEvent.event.type === 'annotation.body.updated') {
          await this.applyEventToGraph(storedEvent);
        }
      }
    }
    this.logger.info('Pass 2 complete - all edges created');

    this.logger.info('Rebuild complete');
  }

  /**
   * Get consumer health metrics.
   */
  getHealthMetrics(): {
    subscriptions: number;
    lastProcessed: Record<string, number>;
    pipelineActive: boolean;
  } {
    return {
      subscriptions: this._globalSubscription ? 1 : 0,
      lastProcessed: Object.fromEntries(this.lastProcessed),
      pipelineActive: !!this.pipelineSubscription,
    };
  }

  /**
   * Shutdown consumer.
   */
  async shutdown(): Promise<void> {
    await this.stop();
    this.logger.info('GraphDB consumer shut down');
  }
}
