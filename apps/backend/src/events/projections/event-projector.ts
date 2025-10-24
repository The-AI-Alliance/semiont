/**
 * Event Projector - Projection Management
 *
 * Builds document state (Layer 3) from events (Layer 2):
 * - Full projection rebuild from scratch
 * - Incremental projection updates
 * - System-level projections (entity types)
 *
 * @see docs/EVENT-STORE.md#eventprojector for architecture details
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { didToAgent } from '../../utils/id-generator';
import type {
  DocumentEvent,
  StoredEvent,
  Document,
  DocumentAnnotations,
} from '@semiont/core';
import { compareAnnotationIds, findBodyItem } from '@semiont/core';
import type { ProjectionStorage, DocumentState } from '../../storage/projection-storage';

export interface ProjectorConfig {
  basePath: string;
}

/**
 * EventProjector builds and maintains projections (Layer 3) from events (Layer 2)
 */
export class EventProjector {
  constructor(
    private projectionStorage: ProjectionStorage,
    private config: ProjectorConfig
  ) {}

  /**
   * Build document projection from events
   * Loads from Layer 3 if exists, otherwise rebuilds from Layer 2 events
   */
  async projectDocument(events: StoredEvent[], documentId: string): Promise<DocumentState | null> {
    // Try to load existing projection from Layer 3
    const existing = await this.projectionStorage.getProjection(documentId);
    if (existing) {
      return existing;
    }

    // No projection exists - rebuild from Layer 2 events
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
  async updateProjectionIncremental(
    documentId: string,
    event: DocumentEvent,
    getAllEvents: () => Promise<StoredEvent[]>
  ): Promise<void> {
    console.log(`[EventProjector] Updating projection for ${documentId} with event ${event.type}`);

    // Try to load existing projection
    let projection = await this.projectionStorage.getProjection(documentId);

    if (!projection) {
      // No projection exists - do full rebuild from all events
      console.log(`[EventProjector] No projection found, rebuilding from scratch`);
      const events = await getAllEvents();
      projection = this.buildProjectionFromEvents(events, documentId);
    } else {
      // Apply single event incrementally to existing projection
      console.log(`[EventProjector] Applying event incrementally to existing projection (version ${projection.annotations.version})`);
      this.applyEventToDocument(projection.document, event);
      this.applyEventToAnnotations(projection.annotations, event);
      projection.annotations.version++;
      projection.annotations.updatedAt = event.timestamp;
    }

    // Save updated projection
    await this.projectionStorage.saveProjection(documentId, projection);
    console.log(`[EventProjector] Projection saved (version ${projection.annotations.version}, ${projection.annotations.annotations.length} annotations)`);
  }

  /**
   * Build projection from event list (full rebuild)
   */
  private buildProjectionFromEvents(events: StoredEvent[], documentId: string): DocumentState {
    // Start with empty document state
    const document: Document = {
      id: documentId,
      name: '',
      format: 'text/markdown',
      contentChecksum: documentId.replace('doc-sha256:', ''),
      entityTypes: [],
      archived: false,
      created: '',
      creationMethod: 'api',
      creator: {
        id: '',
        type: 'Person',
        name: '',
      },
    };

    // Start with empty annotations
    const annotations: DocumentAnnotations = {
      documentId,
      annotations: [],
      version: 0,
      updatedAt: '',
    };

    // Apply events in sequenceNumber order
    events.sort((a, b) => a.metadata.sequenceNumber - b.metadata.sequenceNumber);

    for (const storedEvent of events) {
      this.applyEventToDocument(document, storedEvent.event);
      this.applyEventToAnnotations(annotations, storedEvent.event);
      annotations.version++;
      annotations.updatedAt = storedEvent.event.timestamp;
    }

    return { document, annotations };
  }

  /**
   * Apply an event to Document state (metadata only)
   */
  private applyEventToDocument(document: Document, event: DocumentEvent): void {
    switch (event.type) {
      case 'document.created':
        document.name = event.payload.name;
        document.format = event.payload.format;
        document.entityTypes = event.payload.entityTypes || [];
        document.created = event.timestamp;
        document.creationMethod = event.payload.creationMethod || 'api';
        document.creator = didToAgent(event.userId);
        document.contentChecksum = event.payload.contentChecksum;

        // First-class fields
        document.language = event.payload.language;
        document.isDraft = event.payload.isDraft;
        document.generatedFrom = event.payload.generatedFrom;
        break;

      case 'document.cloned':
        document.name = event.payload.name;
        document.format = event.payload.format;
        document.entityTypes = event.payload.entityTypes || [];
        document.created = event.timestamp;
        document.creationMethod = 'clone';
        document.sourceDocumentId = event.payload.parentDocumentId;
        document.creator = didToAgent(event.userId);
        document.contentChecksum = event.payload.contentChecksum;

        // First-class fields
        document.language = event.payload.language;
        break;

      case 'document.archived':
        document.archived = true;
        break;

      case 'document.unarchived':
        document.archived = false;
        break;

      case 'entitytag.added':
        if (!document.entityTypes.includes(event.payload.entityType)) {
          document.entityTypes.push(event.payload.entityType);
        }
        break;

      case 'entitytag.removed':
        document.entityTypes = document.entityTypes.filter(
          t => t !== event.payload.entityType
        );
        break;

      // Annotation events don't affect document metadata
      case 'annotation.added':
      case 'annotation.removed':
      case 'annotation.body.updated':
        break;

      // System events don't affect document metadata
      case 'entitytype.added':
        break;
    }
  }

  /**
   * Apply an event to DocumentAnnotations (annotation collections only)
   */
  private applyEventToAnnotations(annotations: DocumentAnnotations, event: DocumentEvent): void {
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
          a => !compareAnnotationIds(a.id, event.payload.annotationId)
        );
        break;

      case 'annotation.body.updated':
        // Find annotation by ID
        const annotation = annotations.annotations.find(a =>
          compareAnnotationIds(a.id, event.payload.annotationId)
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

      // Document metadata events don't affect annotations
      case 'document.created':
      case 'document.cloned':
      case 'document.archived':
      case 'document.unarchived':
      case 'entitytag.added':
      case 'entitytag.removed':
        break;

      // System events don't affect annotations
      case 'entitytype.added':
        break;
    }
  }

  /**
   * Update entity types projection (Layer 3) - System-level projection
   */
  async updateEntityTypesProjection(entityType: string): Promise<void> {
    const entityTypesPath = path.join(
      this.config.basePath,
      'projections',
      'entity-types',
      'entity-types.json'
    );

    console.log(`[EventProjector] Updating entity types projection: ${entityType} at ${entityTypesPath}`);

    // Read current projection
    let projection = { entityTypes: [] as string[] };
    try {
      const content = await fs.readFile(entityTypesPath, 'utf-8');
      projection = JSON.parse(content);
      console.log(`[EventProjector] Read existing projection with ${projection.entityTypes.length} types`);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      console.log(`[EventProjector] Projection file doesn't exist, creating new one`);
      // File doesn't exist - will create it
    }

    // Add entity type (idempotent - Set ensures uniqueness)
    const entityTypeSet = new Set(projection.entityTypes);
    entityTypeSet.add(entityType);
    projection.entityTypes = Array.from(entityTypeSet).sort();

    // Write projection
    await fs.mkdir(path.dirname(entityTypesPath), { recursive: true });
    await fs.writeFile(entityTypesPath, JSON.stringify(projection, null, 2));
    console.log(`[EventProjector] Wrote projection with ${projection.entityTypes.length} types to ${entityTypesPath}`);
  }
}
