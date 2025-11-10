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
import { didToAgent } from '../../utils/id-generator';
import type { components } from '@semiont/api-client';

type Representation = components['schemas']['Representation'];
type Annotation = components['schemas']['Annotation'];
import type {
  ResourceEvent,
  StoredEvent,
  ResourceAnnotations,
  ResourceId,
} from '@semiont/core';
import { findBodyItem } from '@semiont/core';
import type { ViewStorage, ResourceView } from '../../storage/view-storage';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export interface ViewMaterializerConfig {
  basePath: string;
  backendUrl: string;
}

/**
 * ViewMaterializer builds and maintains materialized views from events
 */
export class ViewMaterializer {
  constructor(
    private viewStorage: ViewStorage,
    private config: ViewMaterializerConfig
  ) {}

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
    event: ResourceEvent,
    getAllEvents: () => Promise<StoredEvent[]>
  ): Promise<void> {
    console.log(`[ViewMaterializer] Updating view for ${resourceId} with event ${event.type}`);

    // Try to load existing view
    let view = await this.viewStorage.get(resourceId);

    if (!view) {
      // No view exists - do full rebuild from all events
      console.log(`[ViewMaterializer] No view found, rebuilding from scratch`);
      const events = await getAllEvents();
      view = this.materializeFromEvents(events, resourceId);
    } else {
      // Apply single event incrementally to existing view
      console.log(`[ViewMaterializer] Applying event incrementally to existing view (version ${view.annotations.version})`);
      this.applyEventToResource(view.resource, event);
      this.applyEventToAnnotations(view.annotations, event);
      view.annotations.version++;
      view.annotations.updatedAt = event.timestamp;
    }

    // Save updated view
    await this.viewStorage.save(resourceId, view);
    console.log(`[ViewMaterializer] View saved (version ${view.annotations.version}, ${view.annotations.annotations.length} annotations)`);
  }

  /**
   * Materialize view from event list (full rebuild)
   */
  private materializeFromEvents(events: StoredEvent[], resourceId: ResourceId): ResourceView {
    // Build W3C-compliant HTTP URI for @id
    const backendUrl = this.config.backendUrl;
    const normalizedBase = backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl;

    // Start with empty ResourceDescriptor state
    const resource: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': `${normalizedBase}/resources/${resourceId}`,
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
      this.applyEventToResource(resource, storedEvent.event);
      this.applyEventToAnnotations(annotations, storedEvent.event);
      annotations.version++;
      annotations.updatedAt = storedEvent.event.timestamp;
    }

    return { resource, annotations };
  }

  /**
   * Apply an event to ResourceDescriptor state (metadata only)
   */
  private applyEventToResource(resource: ResourceDescriptor, event: ResourceEvent): void {
    switch (event.type) {
      case 'resource.created':
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
        resource.wasDerivedFrom = event.payload.generatedFrom;
        break;

      case 'resource.cloned':
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

      case 'resource.archived':
        resource.archived = true;
        break;

      case 'resource.unarchived':
        resource.archived = false;
        break;

      case 'entitytag.added':
        if (!resource.entityTypes) resource.entityTypes = [];
        if (!resource.entityTypes.includes(event.payload.entityType)) {
          resource.entityTypes.push(event.payload.entityType);
        }
        break;

      case 'entitytag.removed':
        if (resource.entityTypes) {
          resource.entityTypes = resource.entityTypes.filter(
            (t: string) => t !== event.payload.entityType
          );
        }
        break;

      // Annotation events don't affect resource metadata
      case 'annotation.added':
      case 'annotation.removed':
      case 'annotation.body.updated':
        break;

      // System events don't affect resource metadata
      case 'entitytype.added':
        break;
    }
  }

  /**
   * Apply an event to ResourceAnnotations (annotation collections only)
   */
  private applyEventToAnnotations(annotations: ResourceAnnotations, event: ResourceEvent): void {
    switch (event.type) {
      case 'annotation.added':
        // Event payload contains Omit<Annotation, 'creator' | 'created'> (includes @context and type)
        // Add creator/created from event metadata
        annotations.annotations.push({
          ...event.payload.annotation,
          creator: didToAgent(event.userId),
          created: new Date(event.timestamp).toISOString(),
        });
        break;

      case 'annotation.removed':
        annotations.annotations = annotations.annotations.filter(
          (a: Annotation) => a.id !== event.payload.annotationId
        );
        break;

      case 'annotation.body.updated':
        // Find annotation by ID
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
      case 'resource.created':
      case 'resource.cloned':
      case 'resource.archived':
      case 'resource.unarchived':
      case 'entitytag.added':
      case 'entitytag.removed':
        break;

      // System events don't affect annotations
      case 'entitytype.added':
        break;
    }
  }

  /**
   * Materialize entity types view - System-level view
   */
  async materializeEntityTypes(entityType: string): Promise<void> {
    const entityTypesPath = path.join(
      this.config.basePath,
      'projections',
      'entity-types',
      'entity-types.json'
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
