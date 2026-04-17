/**
 * View Materializer - Materialized View Management
 *
 * Materializes resource views from events:
 * - Full view materialization from scratch
 * - Incremental view updates
 * - System-level views (entity types)
 *
 * @see docs/EVENT-STORE.md#viewmaterializer for architecture details
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { didToAgent } from '@semiont/core';
import type { components } from '@semiont/core';

type Representation = components['schemas']['Representation'];
type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

import type {
  PersistedEvent,
  StoredEvent,
  ResourceAnnotations,
  ResourceId,
  Logger,
} from '@semiont/core';
import { findBodyItem } from '@semiont/core';
import type { ViewStorage, ResourceView } from '../storage/view-storage';
import { writeStorageUriEntry, removeStorageUriEntry } from '../storage/storage-uri-index';

/**
 * Minimal structural type for the event log dependency of `rebuildAll`.
 * Avoids importing the concrete EventLog class from a sibling directory and
 * keeps the materializer independent of the event-log implementation.
 */
export interface RebuildEventSource {
  getEvents(resourceId: ResourceId): Promise<StoredEvent[]>;
  getAllResourceIds(): Promise<ResourceId[]>;
}

export interface ViewMaterializerConfig {
  basePath: string;
}

/**
 * ViewMaterializer builds and maintains materialized views from events
 */
export class ViewMaterializer {
  private logger?: Logger;

  constructor(
    private viewStorage: ViewStorage,
    private config: ViewMaterializerConfig,
    logger?: Logger
  ) {
    this.logger = logger;
  }

  /**
   * Materialize resource view from events
   * Loads existing view if cached, otherwise rebuilds from events
   */
  async materialize(events: StoredEvent[], resourceId: ResourceId): Promise<ResourceView | null> {
    // Try to load existing view
    const existing = await this.viewStorage.get(resourceId);
    if (existing) {
      return existing;
    }

    // No view exists - rebuild from events
    if (events.length === 0) return null;

    const view = this.materializeFromEvents(events, resourceId);

    // Save rebuilt view
    await this.viewStorage.save(resourceId, view);

    return view;
  }

  /**
   * Materialize view incrementally with a single event
   * Falls back to full rebuild if view doesn't exist
   */
  async materializeIncremental(
    resourceId: ResourceId,
    event: PersistedEvent,
    getAllEvents: () => Promise<StoredEvent[]>
  ): Promise<void> {
    this.logger?.info('[ViewMaterializer] Updating view for resource with event', { resourceId, eventType: event.type });

    // Try to load existing view
    let view = await this.viewStorage.get(resourceId);

    if (!view) {
      // No view exists - do full rebuild from all events
      this.logger?.info('[ViewMaterializer] No view found, rebuilding from scratch', { resourceId });
      const events = await getAllEvents();
      view = this.materializeFromEvents(events, resourceId);
    } else {
      // Apply single event incrementally to existing view
      this.logger?.info('[ViewMaterializer] Applying event incrementally to existing view', { resourceId, version: view.annotations.version });
      this.applyEventToResource(view.resource, event);
      this.applyEventToAnnotations(view.annotations, event);
      view.annotations.version++;
      view.annotations.updatedAt = event.timestamp;
    }

    // Save updated view
    await this.viewStorage.save(resourceId, view);
    this.logger?.info('[ViewMaterializer] View saved', { resourceId, version: view.annotations.version, annotationCount: view.annotations.annotations.length });

    // Update storage-uri index for URI-bearing events
    await this.materializeStorageUriIndex(resourceId, event);
  }

  /**
   * Update the storage-uri index in response to an event.
   *
   * Only yield:created (with storageUri), yield:moved, need index changes.
   * resource.archived / resource.unarchived do NOT modify the index.
   */
  private async materializeStorageUriIndex(resourceId: ResourceId, event: PersistedEvent): Promise<void> {
    const projectionsDir = path.join(this.config.basePath, 'projections');

    if (event.type === 'yield:created' && event.payload.storageUri) {
      await writeStorageUriEntry(projectionsDir, event.payload.storageUri, resourceId as string);
    } else if (event.type === 'yield:moved') {
      // Remove old URI, add new URI
      await removeStorageUriEntry(projectionsDir, event.payload.fromUri);
      await writeStorageUriEntry(projectionsDir, event.payload.toUri, resourceId as string);
    }
  }

  /**
   * Materialize view from event list (full rebuild)
   */
  private materializeFromEvents(events: StoredEvent[], resourceId: ResourceId): ResourceView {
    // Start with empty ResourceDescriptor state
    // @id uses bare resource ID; full URI is constructed at the API boundary
    const resource: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': resourceId as string,
      name: '',
      representations: [],
      archived: false,
      entityTypes: [],
      creationMethod: 'api',
    };

    // Start with empty annotations
    const annotations: ResourceAnnotations = {
      resourceId,
      annotations: [],
      version: 0,
      updatedAt: '',
    };

    // Apply events in sequenceNumber order
    events.sort((a, b) => a.metadata.sequenceNumber - b.metadata.sequenceNumber);

    for (const storedEvent of events) {
      this.applyEventToResource(resource, storedEvent);
      this.applyEventToAnnotations(annotations, storedEvent);
      annotations.version++;
      annotations.updatedAt = storedEvent.timestamp;
    }

    return { resource, annotations };
  }

  /**
   * Apply an event to ResourceDescriptor state (metadata only)
   */
  private applyEventToResource(resource: ResourceDescriptor, event: PersistedEvent): void {
    switch (event.type) {
      case 'yield:created':
        resource.name = event.payload.name;
        resource.entityTypes = event.payload.entityTypes || [];
        resource.dateCreated = event.timestamp;
        resource.creationMethod = event.payload.creationMethod || 'api';
        resource.wasAttributedTo = didToAgent(event.userId);

        // Create representation from format and checksum
        if (!resource.representations) resource.representations = [];
        const reps = Array.isArray(resource.representations) ? resource.representations : [resource.representations];
        reps.push({
          mediaType: event.payload.format,
          checksum: event.payload.contentChecksum,
          byteSize: event.payload.contentByteSize,
          rel: 'original',
          language: event.payload.language,
        } as Representation);
        resource.representations = reps;

        // First-class fields
        resource.isDraft = event.payload.isDraft;
        if (event.payload.generatedFrom) resource.wasDerivedFrom = event.payload.generatedFrom.resourceId;
        if (event.payload.generator) resource.generator = event.payload.generator;

        // Working-tree URI and current checksum
        if (event.payload.storageUri) {
          resource.storageUri = event.payload.storageUri;
        }
        resource.currentChecksum = event.payload.contentChecksum;
        break;

      case 'yield:cloned':
        resource.name = event.payload.name;
        resource.entityTypes = event.payload.entityTypes || [];
        resource.dateCreated = event.timestamp;
        resource.creationMethod = 'clone';
        resource.sourceResourceId = event.payload.parentResourceId;
        resource.wasAttributedTo = didToAgent(event.userId);

        // Create representation from format and checksum
        if (!resource.representations) resource.representations = [];
        const reps2 = Array.isArray(resource.representations) ? resource.representations : [resource.representations];
        reps2.push({
          mediaType: event.payload.format,
          checksum: event.payload.contentChecksum,
          byteSize: event.payload.contentByteSize,
          rel: 'original',
          language: event.payload.language,
        } as Representation);
        resource.representations = reps2;
        break;

      case 'yield:updated':
        resource.currentChecksum = event.payload.contentChecksum;
        resource.dateModified = event.timestamp;
        break;

      case 'yield:moved':
        resource.storageUri = event.payload.toUri;
        resource.dateModified = event.timestamp;
        break;

      case 'mark:archived':
        resource.archived = true;
        break;

      case 'mark:unarchived':
        resource.archived = false;
        break;

      case 'yield:representation-added': {
        const { representation } = event.payload;

        // Add to representations array (avoid duplicates by checksum)
        if (!resource.representations) {
          resource.representations = [];
        }

        const repsArray = Array.isArray(resource.representations)
          ? resource.representations
          : [resource.representations];

        // Check if representation already exists
        const exists = repsArray.some(r => r.checksum === representation.checksum);
        if (!exists) {
          resource.representations = [...repsArray, representation];
        }
        break;
      }

      case 'yield:representation-removed': {
        const { checksum } = event.payload;

        if (resource.representations) {
          const repsArray = Array.isArray(resource.representations)
            ? resource.representations
            : [resource.representations];

          resource.representations = repsArray.filter(r => r.checksum !== checksum);
        }
        break;
      }

      case 'mark:entity-tag-added':
        if (!resource.entityTypes) resource.entityTypes = [];
        if (!resource.entityTypes.includes(event.payload.entityType)) {
          resource.entityTypes.push(event.payload.entityType);
        }
        break;

      case 'mark:entity-tag-removed':
        if (resource.entityTypes) {
          resource.entityTypes = resource.entityTypes.filter(
            (t: string) => t !== event.payload.entityType
          );
        }
        break;

      // Annotation events don't affect resource metadata
      case 'mark:added':
      case 'mark:removed':
      case 'mark:body-updated':
        break;

      // Job events don't affect resource metadata
      case 'job:started':
      case 'job:progress':
      case 'job:completed':
      case 'job:failed':
        break;

      // System events don't affect resource metadata
      case 'mark:entity-type-added':
        break;
    }
  }

  /**
   * Apply an event to ResourceAnnotations (annotation collections only)
   */
  private applyEventToAnnotations(annotations: ResourceAnnotations, event: PersistedEvent): void {
    switch (event.type) {
      case 'mark:added':
        annotations.annotations.push(event.payload.annotation);
        break;

      case 'mark:removed':
        annotations.annotations = annotations.annotations.filter(
          (a: Annotation) => a.id !== event.payload.annotationId
        );
        break;

      case 'mark:body-updated':
        const annotation = annotations.annotations.find((a: Annotation) =>
          a.id === event.payload.annotationId
        );
        if (annotation) {
          // Ensure body is an array
          if (!Array.isArray(annotation.body)) {
            annotation.body = annotation.body ? [annotation.body] : [];
          }

          // Apply each operation
          for (const op of event.payload.operations) {
            if (op.op === 'add') {
              // Add item (idempotent - don't add if already exists)
              const exists = findBodyItem(annotation.body, op.item) !== -1;
              if (!exists) {
                annotation.body.push(op.item);
              }
            } else if (op.op === 'remove') {
              // Remove item
              const index = findBodyItem(annotation.body, op.item);
              if (index !== -1) {
                annotation.body.splice(index, 1);
              }
            } else if (op.op === 'replace') {
              // Replace item
              const index = findBodyItem(annotation.body, op.oldItem);
              if (index !== -1) {
                annotation.body[index] = op.newItem;
              }
            }
          }

          // Update modified timestamp
          annotation.modified = new Date(event.timestamp).toISOString();
        }
        break;

      // Resource metadata events don't affect annotations
      case 'yield:created':
      case 'yield:cloned':
      case 'yield:updated':
      case 'yield:moved':
      case 'mark:archived':
      case 'mark:unarchived':
      case 'yield:representation-added':
      case 'yield:representation-removed':
      case 'mark:entity-tag-added':
      case 'mark:entity-tag-removed':
        break;

      // Job events don't affect annotations
      case 'job:started':
      case 'job:progress':
      case 'job:completed':
      case 'job:failed':
        break;

      // System events don't affect annotations
      case 'mark:entity-type-added':
        break;
    }
  }

  /**
   * Walk every event stream in the event log and materialize the corresponding
   * view from scratch. Idempotent: existing view files are overwritten.
   *
   * Mirrors GraphDBConsumer.rebuildAll() and Smelter.rebuildAll() — this is the
   * recovery path that makes the ephemeral stateDir safe to wipe. The live
   * append path (EventStore.appendEvent → materializeIncremental /
   * materializeEntityTypes) is unchanged and runs in addition.
   */
  async rebuildAll(eventLog: RebuildEventSource): Promise<void> {
    this.logger?.info('[ViewMaterializer] Rebuilding all materialized views from event log');

    const SYSTEM_ID = '__system__' as unknown as ResourceId;

    // Pass 1: __system__ events — produces system projections
    // (currently entitytypes.json; future system projections plug in here)
    const systemEvents = await eventLog.getEvents(SYSTEM_ID);
    this.logger?.info('[ViewMaterializer] Replaying system events', { count: systemEvents.length });
    for (const event of systemEvents) {
      if (event.type === 'mark:entity-type-added') {
        await this.materializeEntityTypes((event.payload as { entityType: string }).entityType);
      }
    }

    // Pass 2: resource-scoped events — produces resource views and the
    // storage-uri index
    const allResourceIds = await eventLog.getAllResourceIds();
    const resourceIds = allResourceIds.filter(
      (rid) => (rid as unknown as string) !== '__system__'
    );
    this.logger?.info('[ViewMaterializer] Rebuilding resource views', { count: resourceIds.length });
    let skipped = 0;
    for (const rid of resourceIds) {
      try {
        const events = await eventLog.getEvents(rid);
        if (events.length === 0) continue;

        const view = this.materializeFromEvents(events, rid);
        await this.viewStorage.save(rid, view);

        for (const event of events) {
          await this.materializeStorageUriIndex(rid, event);
        }
      } catch (error) {
        skipped++;
        this.logger?.error('[ViewMaterializer] Failed to rebuild resource view', {
          resourceId: String(rid),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger?.info('[ViewMaterializer] Rebuild complete', {
      systemEvents: systemEvents.length,
      resources: resourceIds.length,
      skipped,
    });
  }

  /**
   * Materialize entity types view - System-level view
   */
  async materializeEntityTypes(entityType: string): Promise<void> {
    const entityTypesPath = path.join(
      this.config.basePath,
      'projections',
      '__system__',
      'entitytypes.json'
    );


    // Read current view
    let view = { entityTypes: [] as string[] };
    try {
      const content = await fs.readFile(entityTypesPath, 'utf-8');
      view = JSON.parse(content);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      // File doesn't exist - will create it
    }

    // Add entity type (idempotent - Set ensures uniqueness)
    const entityTypeSet = new Set(view.entityTypes);
    entityTypeSet.add(entityType);
    view.entityTypes = Array.from(entityTypeSet).sort();

    // Write view
    await fs.mkdir(path.dirname(entityTypesPath), { recursive: true });
    await fs.writeFile(entityTypesPath, JSON.stringify(view, null, 2));
  }
}
