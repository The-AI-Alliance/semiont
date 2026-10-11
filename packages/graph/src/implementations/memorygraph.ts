// In-memory implementation of GraphDatabase interface
// Used for development and testing without requiring a real graph database

import { GraphDatabase } from '../interface';
import { assertMutableResourceUpdate } from '../interface';
import { queryResources } from '../resource-query';
import type { Logger } from '@semiont/core';
import type {
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  ResourceFilter,
  UpdateResourceInput,
  CreateAnnotationInternal,
  ResourceId,
  AnnotationId,
} from '@semiont/core';
import { getBodySource, getTargetSource, getResourceId, getPrimaryRepresentation, getResourceEntityTypes } from '@semiont/core';
import { getEntityTypes } from '@semiont/core';
import { buildAnnotation, decodeAnnotation, encodeAnnotation, resolvedBody, updatedAnnotation } from '../annotation-codec';
import { decodeResource, encodeResource } from '../resource-codec';
import type { ResourceDescriptor } from '@semiont/core';
import type { Annotation } from '@semiont/core';

// Simple in-memory storage using Maps
// Useful for development and testing

export class MemoryGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  private logger?: Logger;

  // In-memory storage using Maps
  private resources: Map<string, ResourceDescriptor> = new Map();
  private annotations: Map<string, Annotation> = new Map();

  constructor(config: { logger?: Logger } = {}) {
    this.logger = config.logger;
  }
  
  async connect(): Promise<void> {
    // No actual connection needed for in-memory storage
    this.logger?.info('Using in-memory graph database');
    this.connected = true;
  }
  
  async disconnect(): Promise<void> {
    // Nothing to close for in-memory storage
    this.connected = false;
  }
  
  isConnected(): boolean {
    return this.connected;
  }

  async createResource(resource: ResourceDescriptor): Promise<ResourceDescriptor> {
    const id = getResourceId(resource);
    if (!id) {
      throw new Error('Resource must have an id');
    }

    // Through the codec, as an annotation is: this store is the reference
    // the contract suite runs against, and a Map that kept a descriptor as
    // given would answer with fields no database holds.
    const stored = decodeResource(encodeResource(resource));
    this.resources.set(id, stored);
    return stored;
  }
  
  async getResource(id: ResourceId): Promise<ResourceDescriptor | null> {
    return this.resources.get(String(id)) || null;
  }

  async updateResource(id: ResourceId, input: UpdateResourceInput): Promise<ResourceDescriptor> {
    assertMutableResourceUpdate(input);

    const doc = this.resources.get(String(id));
    if (!doc) throw new Error('Resource not found');

    if (input.archived !== undefined) doc.archived = input.archived;
    if (input.entityTypes !== undefined) doc.entityTypes = input.entityTypes;
    return doc;
  }

  async deleteResource(id: ResourceId): Promise<void> {
    this.resources.delete(String(id));

    // The annotations ON this resource go with it. Another resource's
    // annotation that links here is that resource's, and stays.
    const idStr = String(id);
    for (const [selId, sel] of this.annotations) {
      if (getTargetSource(sel.target) === idStr) {
        this.annotations.delete(selId);
      }
    }
  }
  
  async listResources(filter: ResourceFilter): Promise<{ resources: ResourceDescriptor[]; total: number }> {
    return queryResources(Array.from(this.resources.values()), filter);
  }

  
  async createAnnotation(input: CreateAnnotationInternal): Promise<Annotation> {
    // The caller's id is the system of record's — never mint a fresh one
    // (the event-log id is what deletes and lookups arrive under).
    const id = input.id;

    // Nothing here needs serializing — but this store is the reference the
    // interface-contract suite runs against, and a reference that cannot
    // exhibit what the real stores exhibit hides codec divergences between
    // them. So the annotation round-trips through the codec: what a Map
    // hands back is exactly what Cypher and Gremlin hand back.
    const annotation = decodeAnnotation(
      encodeAnnotation(buildAnnotation(input)),
      getEntityTypes(input)
    );

    this.annotations.set(id, annotation);
    this.logger?.debug('Created annotation', {
      id,
      motivation: annotation.motivation,
      hasSource: !!getBodySource(annotation.body),
      targetSource: getTargetSource(annotation.target)
    });
    return annotation;
  }
  
  async getAnnotation(id: AnnotationId): Promise<Annotation | null> {
    return this.annotations.get(id) || null;
  }
  
  async updateAnnotation(id: AnnotationId, updates: Partial<Annotation>): Promise<Annotation> {
    const annotation = this.annotations.get(id);
    if (!annotation) throw new Error('Annotation not found');

    // What the codec says the update leaves, as a server store holds it: a
    // Map that kept the fields as given would hold what no database does
    // (an empty body where the codec writes none), and hide it from every
    // test that runs here.
    const updated = updatedAnnotation(annotation, updates);

    this.annotations.set(id, updated);
    return updated;
  }
  
  async deleteAnnotation(id: AnnotationId): Promise<void> {
    this.annotations.delete(id);
  }
  
  async resolveReference(annotationId: AnnotationId, source: ResourceId): Promise<Annotation> {
    const annotation = this.annotations.get(annotationId);
    if (!annotation) throw new Error('Annotation not found');
    return this.updateAnnotation(annotationId, { body: resolvedBody(annotation, source) });
  }

  private async getReferences(resourceId: ResourceId): Promise<Annotation[]> {
    const resourceIdStr = String(resourceId);
    const references = Array.from(this.annotations.values())
      .filter(sel => getTargetSource(sel.target) === resourceIdStr && sel.motivation === 'linking');
    this.logger?.debug('Got references for resource', { resourceId, count: references.length });
    return references;
  }

  async getResourceAnnotations(resourceId: ResourceId): Promise<Annotation[]> {
    const resourceIdStr = String(resourceId);
    return Array.from(this.annotations.values())
      .filter(sel => getTargetSource(sel.target) === resourceIdStr);
  }

  async getResourceReferencedBy(resourceId: ResourceId, _motivation?: string): Promise<Annotation[]> {
    return Array.from(this.annotations.values())
      .filter(sel => getBodySource(sel.body) === String(resourceId));
  }

  async getResourceConnections(resourceId: ResourceId): Promise<GraphConnection[]> {
    const connections: GraphConnection[] = [];
    const refs = await this.getReferences(resourceId);
    const resourceIdStr = String(resourceId);

    for (const ref of refs) {
      const bodySource = getBodySource(ref.body);
      if (bodySource) {
        const targetDoc = await this.getResource(bodySource);
        if (targetDoc) {
          const reverseRefs = await this.getReferences(bodySource);
          const bidirectional = reverseRefs.some(r => getBodySource(r.body) === resourceIdStr);

          connections.push({
            targetResource: targetDoc,
            annotations: [ref],
            bidirectional,
          });
        }
      }
    }

    return connections;
  }

  async findPath(fromResourceId: ResourceId, toResourceId: ResourceId, maxDepth: number = 5): Promise<GraphPath[]> {
    const visited = new Set<ResourceId>();
    const queue: { docId: ResourceId; path: ResourceDescriptor[]; sels: Annotation[] }[] = [];
    const fromDoc = await this.getResource(fromResourceId);

    if (!fromDoc) return [];

    queue.push({ docId: fromResourceId, path: [fromDoc], sels: [] });
    visited.add(fromResourceId);

    const paths: GraphPath[] = [];

    while (queue.length > 0 && paths.length < 10) {
      const { docId, path, sels } = queue.shift()!;

      if (path.length > maxDepth) continue;

      if (docId === toResourceId) {
        paths.push({ resources: path, annotations: sels });
        continue;
      }

      const connections = await this.getResourceConnections(docId);

      for (const conn of connections) {
        const targetId = getResourceId(conn.targetResource);
        if (targetId && !visited.has(targetId)) {
          visited.add(targetId);
          queue.push({
            docId: targetId,
            path: [...path, conn.targetResource],
            sels: [...sels, ...conn.annotations],
          });
        }
      }
    }

    return paths;
  }
  
  async getEntityTypeStats(): Promise<EntityTypeStats[]> {
    const typeCounts = new Map<string, number>();

    for (const doc of this.resources.values()) {
      const types = getResourceEntityTypes(doc);
      for (const type of types) {
        typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
      }
    }
    
    return Array.from(typeCounts.entries()).map(([type, count]) => ({
      type,
      count,
    }));
  }
  
  async getStats(): Promise<{
    resourceCount: number;
    annotationCount: number;
    highlightCount: number;
    referenceCount: number;
    entityReferenceCount: number;
    entityTypes: Record<string, number>;
    contentTypes: Record<string, number>;
  }> {
    const entityTypes: Record<string, number> = {};
    const contentTypes: Record<string, number> = {};

    for (const doc of this.resources.values()) {
      for (const type of doc.entityTypes || []) {
        entityTypes[type] = (entityTypes[type] || 0) + 1;
      }
      const primaryRep = getPrimaryRepresentation(doc);
      if (primaryRep?.mediaType) {
        contentTypes[primaryRep.mediaType] = (contentTypes[primaryRep.mediaType] || 0) + 1;
      }
    }
    
    const annotations = Array.from(this.annotations.values());
    // Use motivation to distinguish types
    const highlightCount = annotations.filter(a => a.motivation === 'highlighting').length;
    const referenceCount = annotations.filter(a => a.motivation === 'linking').length;
    // Extract entity types from annotation body
    const entityReferenceCount = annotations.filter(
      a => a.motivation === 'linking' && getEntityTypes(a).length > 0
    ).length;
    
    return {
      resourceCount: this.resources.size,
      annotationCount: this.annotations.size,
      highlightCount,
      referenceCount,
      entityReferenceCount,
      entityTypes,
      contentTypes,
    };
  }
  
  async batchCreateResources(resources: ResourceDescriptor[]): Promise<ResourceDescriptor[]> {
    const results: ResourceDescriptor[] = [];
    for (const resource of resources) {
      results.push(await this.createResource(resource));
    }
    return results;
  }

  async createAnnotations(inputs: CreateAnnotationInternal[]): Promise<Annotation[]> {
    const results: Annotation[] = [];
    for (const input of inputs) {
      results.push(await this.createAnnotation(input));
    }
    return results;
  }
  
  
  // Tag Collections - an in-memory set
  private entityTypesCollection: Set<string> | null = null;
  
  async getEntityTypes(): Promise<string[]> {
    // Initialize if not already loaded
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    return Array.from(this.entityTypesCollection!).sort();
  }

  async addEntityType(tag: string): Promise<void> {
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    this.entityTypesCollection!.add(tag);
  }

  async addEntityTypes(tags: string[]): Promise<void> {
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    tags.forEach(tag => this.entityTypesCollection!.add(tag));
  }

  private async initializeTagCollections(): Promise<void> {
    // Initialize with defaults if not present
    if (this.entityTypesCollection === null) {
      const { DEFAULT_ENTITY_TYPES } = await import('@semiont/ontology');
      this.entityTypesCollection = new Set(DEFAULT_ENTITY_TYPES);
    }
  }
  
  async clearDatabase(): Promise<void> {
    this.resources.clear();
    this.annotations.clear();
    this.entityTypesCollection = null;
  }
}