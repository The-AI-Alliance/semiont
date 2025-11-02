/**
 * Event Projector - Projection Management
 *
 * Builds resource state (Layer 3) from events (Layer 2):
 * - Full projection rebuild from scratch
 * - Incremental projection updates
 * - System-level projections (entity types)
 * @see docs/EVENT-STORE.md#eventprojector for architecture details
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { didToAgent } from '../../utils/id-generator';
import type { components } from '@semiont/api-client';
import { compareAnnotationIds } from '@semiont/api-client';
type Representation = components['schemas']['Representation'];
import type {
  ResourceEvent,
  StoredEvent,
  ResourceAnnotations,
} from '@semiont/core';
import { findBodyItem } from '@semiont/core';
import type { ProjectionStorage, ResourceState } from '../../storage/projection-storage';
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
export interface ProjectorConfig {
  basePath: string;
}
 * EventProjector builds and maintains projections (Layer 3) from events (Layer 2)
export class EventProjector {
  constructor(
    private projectionStorage: ProjectionStorage,
    private config: ProjectorConfig
  ) {}
  /**
   * Build resource projection from events
   * Loads from Layer 3 if exists, otherwise rebuilds from Layer 2 events
   */
  async projectResource(events: StoredEvent[], resourceId: string): Promise<ResourceState | null> {
    // Try to load existing projection from Layer 3
    const existing = await this.projectionStorage.getProjection(resourceId);
    if (existing) {
      return existing;
    }
    // No projection exists - rebuild from Layer 2 events
    if (events.length === 0) return null;
    const projection = this.buildProjectionFromEvents(events, resourceId);
    // Save rebuilt projection to Layer 3
    await this.projectionStorage.saveProjection(resourceId, projection);
    return projection;
  }
   * Update projection incrementally with a single event
   * Falls back to full rebuild if projection doesn't exist
  async updateProjectionIncremental(
    resourceId: string,
    event: ResourceEvent,
    getAllEvents: () => Promise<StoredEvent[]>
  ): Promise<void> {
    console.log(`[EventProjector] Updating projection for ${resourceId} with event ${event.type}`);
    // Try to load existing projection
    let projection = await this.projectionStorage.getProjection(resourceId);
    if (!projection) {
      // No projection exists - do full rebuild from all events
      console.log(`[EventProjector] No projection found, rebuilding from scratch`);
      const events = await getAllEvents();
      projection = this.buildProjectionFromEvents(events, resourceId);
    } else {
      // Apply single event incrementally to existing projection
      console.log(`[EventProjector] Applying event incrementally to existing projection (version ${projection.annotations.version})`);
      this.applyEventToResource(projection.resource, event);
      this.applyEventToAnnotations(projection.annotations, event);
      projection.annotations.version++;
      projection.annotations.updatedAt = event.timestamp;
    // Save updated projection
    console.log(`[EventProjector] Projection saved (version ${projection.annotations.version}, ${projection.annotations.annotations.length} annotations)`);
   * Build projection from event list (full rebuild)
  private buildProjectionFromEvents(events: StoredEvent[], resourceId: string): ResourceState {
    // Build W3C-compliant HTTP URI for @id
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:4000';
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
    // Apply events in sequenceNumber order
    events.sort((a, b) => a.metadata.sequenceNumber - b.metadata.sequenceNumber);
    for (const storedEvent of events) {
      this.applyEventToResource(resource, storedEvent.event);
      this.applyEventToAnnotations(annotations, storedEvent.event);
      annotations.version++;
      annotations.updatedAt = storedEvent.event.timestamp;
    return { resource, annotations };
   * Apply an event to ResourceDescriptor state (metadata only)
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
          rel: 'original',
          language: event.payload.language,
        } as Representation);
        resource.representations = reps;
        // First-class fields
        resource.isDraft = event.payload.isDraft;
        resource.wasDerivedFrom = event.payload.generatedFrom;
        break;
      case 'resource.cloned':
        resource.creationMethod = 'clone';
        resource.sourceResourceId = event.payload.parentResourceId;
        const reps2 = Array.isArray(resource.representations) ? resource.representations : [resource.representations];
        reps2.push({
        resource.representations = reps2;
      case 'resource.archived':
        resource.archived = true;
      case 'resource.unarchived':
        resource.archived = false;
      case 'entitytag.added':
        if (!resource.entityTypes) resource.entityTypes = [];
        if (!resource.entityTypes.includes(event.payload.entityType)) {
          resource.entityTypes.push(event.payload.entityType);
        }
      case 'entitytag.removed':
        if (resource.entityTypes) {
          resource.entityTypes = resource.entityTypes.filter(
            (t: string) => t !== event.payload.entityType
          );
      // Annotation events don't affect resource metadata
      case 'annotation.added':
      case 'annotation.removed':
      case 'annotation.body.updated':
      // System events don't affect resource metadata
      case 'entitytype.added':
   * Apply an event to ResourceAnnotations (annotation collections only)
  private applyEventToAnnotations(annotations: ResourceAnnotations, event: ResourceEvent): void {
        // Event payload contains Omit<Annotation, 'creator' | 'created'> (includes @context and type)
        // Add creator/created from event metadata
        annotations.annotations.push({
          ...event.payload.annotation,
          creator: didToAgent(event.userId),
          created: new Date(event.timestamp).toISOString(),
        });
        annotations.annotations = annotations.annotations.filter(
          a => !compareAnnotationIds(a.id, event.payload.annotationId)
        );
        // Find annotation by ID
        const annotation = annotations.annotations.find(a =>
          compareAnnotationIds(a.id, event.payload.annotationId)
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
            } else if (op.op === 'replace') {
              // Replace item
              const index = findBodyItem(annotation.body, op.oldItem);
                annotation.body[index] = op.newItem;
            }
          // Update modified timestamp
          annotation.modified = new Date(event.timestamp).toISOString();
      // Resource metadata events don't affect annotations
      // System events don't affect annotations
   * Update entity types projection (Layer 3) - System-level projection
  async updateEntityTypesProjection(entityType: string): Promise<void> {
    const entityTypesPath = path.join(
      this.config.basePath,
      'projections',
      'entity-types',
      'entity-types.json'
    );
    // Read current projection
    let projection = { entityTypes: [] as string[] };
    try {
      const content = await fs.readFile(entityTypesPath, 'utf-8');
      projection = JSON.parse(content);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      // File doesn't exist - will create it
    // Add entity type (idempotent - Set ensures uniqueness)
    const entityTypeSet = new Set(projection.entityTypes);
    entityTypeSet.add(entityType);
    projection.entityTypes = Array.from(entityTypeSet).sort();
    // Write projection
    await fs.mkdir(path.dirname(entityTypesPath), { recursive: true });
    await fs.writeFile(entityTypesPath, JSON.stringify(projection, null, 2));
