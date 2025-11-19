// In-memory implementation of GraphDatabase interface
// Used for development and testing without requiring a real graph database

import { GraphDatabase } from '../interface';
import { getEntityTypes } from '@semiont/api-client';
import type { components } from '@semiont/api-client';
import type {
  AnnotationCategory,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  ResourceFilter,
  UpdateResourceInput,
  CreateAnnotationInternal,
  ResourceId,
  AnnotationId,
} from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
import type { ResourceUri, AnnotationUri } from '@semiont/api-client';
import { resourceUri } from '@semiont/api-client';
import { v4 as uuidv4 } from 'uuid';
import { getBodySource, getTargetSource } from '../../lib/annotation-utils';
import { getResourceId, getEntityTypes as getResourceEntityTypes, getPrimaryRepresentation } from '../../utils/resource-helpers';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];

// Simple in-memory storage using Maps
// Useful for development and testing

export class MemoryGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  
  // In-memory storage using Maps
  private resources: Map<string, ResourceDescriptor> = new Map();
  private annotations: Map<string, Annotation> = new Map();
  
  constructor(config: any = {}) {
    // Config is ignored for in-memory implementation
    void config;
  }
  
  async connect(): Promise<void> {
    // No actual connection needed for in-memory storage
    console.log('Using in-memory graph database...');
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

    // Simply add to in-memory map
    // await this.client.submit(`
    //   graph.tx().rollback()
    //   g.addV('Resource')
    //     .property('id', id)
    //     .property('name', name)
    //     .property('entityTypes', entityTypes)
    //     .property('contentType', contentType)
    //     .property('created', created)
    //     .property('updatedAt', updatedAt)
    //   graph.tx().commit()
    // `, { id, name, entityTypes, ... });

    this.resources.set(id, resource);
    return resource;
  }
  
  async getResource(id: ResourceUri): Promise<ResourceDescriptor | null> {
    // Simply retrieve from map
    // const result = await this.client.submit(`
    //   g.V().hasLabel('Resource').has('id', id).valueMap(true)
    // `, { id });

    return this.resources.get(id) || null;
  }

  async updateResource(id: ResourceUri, input: UpdateResourceInput): Promise<ResourceDescriptor> {
    // Resources are immutable - only archiving is allowed
    if (Object.keys(input).length !== 1 || input.archived === undefined) {
      throw new Error('Resources are immutable. Only archiving is allowed.');
    }

    const doc = this.resources.get(id);
    if (!doc) throw new Error('Resource not found');

    doc.archived = input.archived;
    return doc;
  }
  
  async deleteResource(id: ResourceUri): Promise<void> {
    // Simply delete from map
    // await this.client.submit(`
    //   graph.tx().rollback()
    //   g.V().has('id', id).drop()
    //   graph.tx().commit()
    // `, { id });
    
    this.resources.delete(id);
    
    // Delete annotations
    for (const [selId, sel] of this.annotations) {
      if (getTargetSource(sel.target) === id || getBodySource(sel.body) === id) {
        this.annotations.delete(selId);
      }
    }
  }
  
  async listResources(filter: ResourceFilter): Promise<{ resources: ResourceDescriptor[]; total: number }> {
    let docs = Array.from(this.resources.values());

    if (filter.entityTypes && filter.entityTypes.length > 0) {
      docs = docs.filter(doc =>
        doc.entityTypes && doc.entityTypes.some((type: string) => filter.entityTypes!.includes(type))
      );
    }

    if (filter.search) {
      const searchLower = filter.search.toLowerCase();
      docs = docs.filter(doc =>
        doc.name.toLowerCase().includes(searchLower)
      );
    }

    const total = docs.length;
    const offset = filter.offset || 0;
    const limit = filter.limit || 20;
    docs = docs.slice(offset, offset + limit);

    return { resources: docs, total };
  }

  async searchResources(query: string, limit: number = 20): Promise<ResourceDescriptor[]> {
    // Simple text search in memory
    // const results = await this.client.submit(`
    //   g.V().has('Resource', 'name', textContains(query)).limit(limit).valueMap(true)
    // `, { query, limit });

    const searchLower = query.toLowerCase();
    const results = Array.from(this.resources.values())
      .filter(doc => doc.name.toLowerCase().includes(searchLower))
      .slice(0, limit);
    
    return results;
  }
  
  async createAnnotation(input: CreateAnnotationInternal): Promise<Annotation> {
    const id = this.generateId();

    // Only linking motivation with SpecificResource or empty array (stub)
    const annotation: Annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      id,
      motivation: input.motivation,
      target: input.target,
      body: input.body,
      creator: input.creator,
      created: new Date().toISOString(),
    };

    this.annotations.set(id, annotation);
    console.log('Memory: Created annotation:', {
      id,
      motivation: annotation.motivation,
      hasSource: !!getBodySource(annotation.body),
      targetSource: getTargetSource(annotation.target)
    });
    return annotation;
  }
  
  async getAnnotation(id: AnnotationUri): Promise<Annotation | null> {
    return this.annotations.get(id) || null;
  }
  
  async updateAnnotation(id: AnnotationUri, updates: Partial<Annotation>): Promise<Annotation> {
    const annotation = this.annotations.get(id);
    if (!annotation) throw new Error('Annotation not found');

    const updated: Annotation = {
      ...annotation,
      ...updates,
    };

    // Motivation should come from updates if provided
    // No need to derive from body type

    this.annotations.set(id, updated);
    return updated;
  }
  
  async deleteAnnotation(id: AnnotationUri): Promise<void> {
    this.annotations.delete(id);
  }
  
  async listAnnotations(filter: { resourceId?: ResourceId; type?: AnnotationCategory }): Promise<{ annotations: Annotation[]; total: number }> {
    let results = Array.from(this.annotations.values());

    if (filter.resourceId) {
      results = results.filter(a => getTargetSource(a.target) === filter.resourceId);
    }

    // Only SpecificResource supported, use motivation to distinguish
    if (filter.type) {
      const motivation = filter.type === 'highlight' ? 'highlighting' : 'linking';
      results = results.filter(a => a.motivation === motivation);
    }

    return { annotations: results, total: results.length };
  }
  
  
  async getHighlights(resourceId: ResourceId): Promise<Annotation[]> {
    const highlights = Array.from(this.annotations.values())
      .filter(sel => getTargetSource(sel.target) === resourceId && sel.motivation === 'highlighting');
    console.log(`Memory: getHighlights for ${resourceId} found ${highlights.length} highlights`);
    return highlights;
  }

  async resolveReference(annotationId: AnnotationId, source: ResourceId): Promise<Annotation> {
    const annotation = this.annotations.get(annotationId);
    if (!annotation) throw new Error('Annotation not found');

    // Convert stub (empty array) to resolved SpecificResource
    const updated: Annotation = {
      ...annotation,
      body: {
        type: 'SpecificResource',
        source,
        purpose: 'linking',
      },
    };

    this.annotations.set(annotationId, updated);
    return updated;
  }

  async getReferences(resourceId: ResourceId): Promise<Annotation[]> {
    const references = Array.from(this.annotations.values())
      .filter(sel => getTargetSource(sel.target) === resourceId && sel.motivation === 'linking');
    console.log(`Memory: getReferences for ${resourceId} found ${references.length} references`);
    references.forEach(ref => {
      console.log('  Reference:', {
        id: ref.id,
        source: getBodySource(ref.body),
        entityTypes: getEntityTypes(ref) // from body
      });
    });
    return references;
  }

  async getEntityReferences(resourceId: ResourceId, entityTypes?: string[]): Promise<Annotation[]> {
    // TODO Extract entity types from body
    let refs = Array.from(this.annotations.values())
      .filter(sel => {
        const selEntityTypes = getEntityTypes(sel);
        return getTargetSource(sel.target) === resourceId && selEntityTypes.length > 0;
      });

    if (entityTypes && entityTypes.length > 0) {
      refs = refs.filter(sel => {
        const selEntityTypes = getEntityTypes(sel);
        return selEntityTypes.some((type: string) => entityTypes.includes(type));
      });
    }

    return refs;
  }

  async getResourceAnnotations(resourceId: ResourceId): Promise<Annotation[]> {
    return Array.from(this.annotations.values())
      .filter(sel => getTargetSource(sel.target) === resourceId);
  }

  async getResourceReferencedBy(resourceUri: ResourceUri): Promise<Annotation[]> {
    return Array.from(this.annotations.values())
      .filter(sel => getBodySource(sel.body) === resourceUri);
  }
  
  async getResourceConnections(resourceId: ResourceId): Promise<GraphConnection[]> {
    // Simple in-memory traversal
    // const results = await this.client.submit(`
    //   g.V().has('id', resourceId)
    //     .bothE('REFERENCES').as('e')
    //     .otherV().as('v')
    //     .select('e', 'v')
    // `, { resourceId });
    
    const connections: GraphConnection[] = [];
    const refs = await this.getReferences(resourceId);
    
    for (const ref of refs) {
      const bodySource = getBodySource(ref.body);
      if (bodySource) {
        const targetDoc = await this.getResource(resourceUri(bodySource));
        if (targetDoc) {
          const reverseRefs = await this.getReferences(makeResourceId(bodySource));
          const bidirectional = reverseRefs.some(r => getBodySource(r.body) === resourceId);

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
  
  async findPath(fromResourceId: string, toResourceId: string, maxDepth: number = 5): Promise<GraphPath[]> {
    // Path finding not implemented in memory version
    // const results = await this.client.submit(`
    //   g.V().has('id', fromResourceId)
    //     .repeat(both().simplePath()).times(maxDepth).emit()
    //     .has('id', toResourceId)
    //     .path()
    //     .by(valueMap(true))
    //     .limit(10)
    // `, { fromResourceId, toResourceId, maxDepth });

    // Using BFS implementation for stub
    const visited = new Set<string>();
    const queue: { docId: string; path: ResourceDescriptor[]; sels: Annotation[] }[] = [];
    const fromDoc = await this.getResource(resourceUri(fromResourceId));

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

      const connections = await this.getResourceConnections(makeResourceId(docId));

      for (const conn of connections) {
        const targetId = getResourceId(conn.targetResource);
        if (!visited.has(targetId)) {
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
    // Simple in-memory statistics
    // const results = await this.client.submit(`
    //   g.V().hasLabel('Resource')
    //     .values('entityTypes').unfold()
    //     .groupCount()
    // `);

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
    // TODO Extract entity types from body
    const entityReferenceCount = annotations.filter(a => a.motivation === 'linking' && getEntityTypes(a).length > 0).length;
    
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
  
  async createAnnotations(inputs: CreateAnnotationInternal[]): Promise<Annotation[]> {
    // In production: Use batch operations for better performance
    // const tx = graph.tx()
    // tx.rollback()
    // ... batch operations ...
    // tx.commit()
    
    const results: Annotation[] = [];
    for (const input of inputs) {
      results.push(await this.createAnnotation(input));
    }
    return results;
  }
  
  
  async resolveReferences(inputs: { annotationId: AnnotationId; source: ResourceId }[]): Promise<Annotation[]> {
    const results: Annotation[] = [];
    for (const input of inputs) {
      results.push(await this.resolveReference(input.annotationId, input.source));
    }
    return results;
  }
  
  async detectAnnotations(_resourceId: ResourceId): Promise<Annotation[]> {
    // This would use AI/ML to detect annotations in a resource
    // For now, return empty array as a placeholder
    return [];
  }
  
  // Tag Collections - stored as special vertices in the graph
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
    // Simply add to set
    // await this.client.submit(`g.V().has('tagCollection', 'type', 'entity-types')
    //   .property(set, 'tags', '${tag}')`, {});
  }

  async addEntityTypes(tags: string[]): Promise<void> {
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    tags.forEach(tag => this.entityTypesCollection!.add(tag));
    // Simply add to set
  }
  
  private async initializeTagCollections(): Promise<void> {
    // Initialize in-memory collections
    // const result = await this.client.submit(
    //   `g.V().has('tagCollection', 'type', 'entity-types')
    //    .project('type', 'tags').by('type').by('tags')`, {}
    // );

    // For now, initialize with defaults if not present
    if (this.entityTypesCollection === null) {
      const { DEFAULT_ENTITY_TYPES } = await import('../tag-collections');
      this.entityTypesCollection = new Set(DEFAULT_ENTITY_TYPES);
    }
  }
  
  generateId(): string {
    return uuidv4().replace(/-/g, '').substring(0, 12);
  }
  
  async clearDatabase(): Promise<void> {
    // In production: CAREFUL! This would clear the entire graph
    // await this.client.submit(`g.V().drop()`);
    this.resources.clear();
    this.annotations.clear();
    this.entityTypesCollection = null;
  }
}