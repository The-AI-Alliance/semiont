// JanusGraph implementation with real Gremlin connection
// This replaces the mock in-memory implementation

import { GraphDatabase } from '../interface';
import { assertMutableResourceUpdate } from '../interface';
import { queryResources } from '../resource-query';
import type { Logger } from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
import { getBodySource, getPrimaryRepresentation, getResourceId, getStorageUri } from '@semiont/core';
import { getEntityTypes } from '@semiont/ontology';
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
import { v4 as uuidv4 } from 'uuid';
import {
  buildAnnotation,
  decodeAnnotation,
  encodeAnnotation,
  encodeSelector,
  motivationForCategory,
  storedAnnotationType,
  type AnnotationProperties,
} from '../annotation-codec';

import type { ResourceDescriptor } from '@semiont/core';
import type { Annotation } from '@semiont/core';

/** Helper to get property value from Gremlin vertex properties */
function getPropertyValue(props: any, key: string): any {
  if (!props[key]) return undefined;
  const prop = Array.isArray(props[key]) ? props[key][0] : props[key];
  return prop?.value || prop;
}

/**
 * Convert a JanusGraph vertex to an Annotation.
 *
 * Module-level so the cross-store conformance suite can run this store's
 * decode path with no live JanusGraph: everything past the flattening is the
 * shared codec's. This is where a missing selector used to become `'{}'` and
 * a missing motivation used to become `'linking'`.
 */
export function vertexToAnnotation(vertex: any, entityTypes: string[] = []): Annotation {
  const props = vertex.properties || {};
  const normalized: AnnotationProperties = {};
  for (const key of Object.keys(props)) {
    const value = getPropertyValue(props, key);
    if (value === undefined || value === null) continue;
    normalized[key] = typeof value === 'string' ? value : String(value);
  }
  return decodeAnnotation(normalized, entityTypes);
}

export class JanusGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  private connection: any | null = null;
  private g: any | null = null;
  private logger?: Logger;

  // Tag Collections - cached in memory for performance
  private entityTypesCollection: Set<string> | null = null;


  constructor(
    private graphConfig: {
      host?: string;
      port?: number;
      storageBackend?: 'cassandra' | 'hbase' | 'berkeleydb';
      indexBackend?: 'elasticsearch' | 'solr' | 'lucene';
      logger?: Logger;
    },
  ) {
    this.logger = graphConfig.logger;
  }
  
  async connect(): Promise<void> {
    // Configuration must be provided via constructor
    const host = this.graphConfig.host;
    if (!host) {
      throw new Error('JanusGraph host is required: provide in config');
    }

    const port = this.graphConfig.port;
    if (!port) {
      throw new Error('JanusGraph port is required: provide in config');
    }

    this.logger?.info('Connecting to JanusGraph', { host, port });

    const gremlin = await import('gremlin');
    const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
    const traversal = gremlin.process.AnonymousTraversalSource.traversal;

    this.connection = new DriverRemoteConnection(
      `ws://${host}:${port}/gremlin`,
      {}
    );

    this.g = traversal().withRemote(this.connection);

    // Test the connection with a simple query
    await this.g.V().limit(1).toList();

    this.connected = true;
    this.logger?.info('Successfully connected to JanusGraph');

    // Initialize schema if needed
    await this.initializeSchema();
  }
  
  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
    }
    this.connected = false;
  }
  
  isConnected(): boolean {
    return this.connected;
  }
  
  private async initializeSchema(): Promise<void> {
    // Note: Schema management in JanusGraph typically requires direct access
    // to the management API, which isn't available through Gremlin.
    // In production, you'd run schema initialization scripts separately.
    this.logger?.debug('Schema initialization would happen here in production');
  }
  
  // Helper function to convert vertex to Resource
  private vertexToResource(vertex: any): ResourceDescriptor {
    const props = vertex.properties || {};
    const id = getPropertyValue(props, 'id');

    // Validate required fields
    const creatorRaw = getPropertyValue(props, 'creator');
    const contentChecksum = getPropertyValue(props, 'contentChecksum');
    const mediaType = getPropertyValue(props, 'contentType');

    if (!creatorRaw) throw new Error(`Resource ${id} missing required field: creator`);
    if (!contentChecksum) throw new Error(`Resource ${id} missing required field: contentChecksum`);
    if (!mediaType) throw new Error(`Resource ${id} missing required field: contentType`);

    const creator = typeof creatorRaw === 'string' ? JSON.parse(creatorRaw) : creatorRaw;

    const resource: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': id,
      name: getPropertyValue(props, 'name'),
      entityTypes: JSON.parse(getPropertyValue(props, 'entityTypes') || '[]'),
      representations: [{
        mediaType,
        checksum: contentChecksum,
        rel: 'original',
        storageUri: getPropertyValue(props, 'storageUri') || undefined,
      }],
      archived: getPropertyValue(props, 'archived') === 'true',
      dateCreated: getPropertyValue(props, 'created'),
      wasAttributedTo: creator,
    };

    const sourceAnnotationId = getPropertyValue(props, 'sourceAnnotationId');
    const sourceResourceId = getPropertyValue(props, 'sourceResourceId');

    if (sourceAnnotationId) resource.sourceAnnotationId = sourceAnnotationId;
    if (sourceResourceId) resource.sourceResourceId = sourceResourceId;

    return resource;
  }
  
  // Helper method to fetch annotations with their entity types
  private async fetchAnnotationsWithEntityTypes(annotationVertices: any[]): Promise<Annotation[]> {
    const annotations: Annotation[] = [];

    for (const vertex of annotationVertices) {
      const id = getPropertyValue(vertex.properties || {}, 'id');

      // Fetch entity types for this annotation
      const entityTypeVertices = await this.g!
        .V()
        .has('Annotation', 'id', id)
        .out('TAGGED_AS')
        .has('EntityType')
        .toList();

      const entityTypes = entityTypeVertices.map((v: any) =>
        getPropertyValue(v.properties || {}, 'name')
      ).filter(Boolean);

      annotations.push(vertexToAnnotation(vertex, entityTypes));
    }

    return annotations;
  }


  async createResource(resource: ResourceDescriptor): Promise<ResourceDescriptor> {
    const id = getResourceId(resource);
    const primaryRep = getPrimaryRepresentation(resource);
    if (!primaryRep) {
      throw new Error('Resource must have at least one representation');
    }

    // Create vertex in JanusGraph using fields from ResourceDescriptor
    const vertex = this.g!
      .addV('Resource')
      .property('id', id)
      .property('name', resource.name)
      .property('entityTypes', JSON.stringify(resource.entityTypes))
      .property('contentType', primaryRep.mediaType)
      .property('archived', resource.archived || false)
      .property('created', resource.dateCreated)
      .property('creator', JSON.stringify(resource.wasAttributedTo))
      .property('contentChecksum', primaryRep.checksum);

    if (resource.sourceAnnotationId) {
      vertex.property('sourceAnnotationId', resource.sourceAnnotationId);
    }
    if (resource.sourceResourceId) {
      vertex.property('sourceResourceId', resource.sourceResourceId);
    }
    const storageUri = getStorageUri(resource);
    if (storageUri) {
      vertex.property('storageUri', storageUri);
    }

    await vertex.next();

    this.logger?.info('Created resource vertex in JanusGraph', { id });
    return resource;
  }
  
  async getResource(id: ResourceId): Promise<ResourceDescriptor | null> {
    const vertices = await this.g!
      .V()
      .has('Resource', 'id', id)
      .toList();

    if (vertices.length === 0) {
      return null;
    }

    return this.vertexToResource(vertices[0] as any);
  }
  
  async updateResource(id: ResourceId, input: UpdateResourceInput): Promise<ResourceDescriptor> {
    assertMutableResourceUpdate(input);

    let traversal = this.g!
      .V()
      .has('Resource', 'id', id);
    if (input.archived !== undefined) {
      traversal = traversal.property('archived', input.archived);
    }
    if (input.entityTypes !== undefined) {
      // Mirrors createResource's storage idiom: entityTypes ride as JSON.
      traversal = traversal.property('entityTypes', JSON.stringify(input.entityTypes));
    }
    await traversal.next();

    const updatedResource = await this.getResource(id);
    if (!updatedResource) {
      throw new Error('Resource not found');
    }

    return updatedResource;
  }
  
  async deleteResource(id: ResourceId): Promise<void> {
    // Delete the vertex and all its edges
    await this.g!
      .V()
      .has('Resource', 'id', id)
      .drop()
      .next();

    this.logger?.info('Deleted resource from JanusGraph', { id });
  }
  
  async listResources(filter: ResourceFilter): Promise<{ resources: ResourceDescriptor[]; total: number }> {
    // Note: filtering is done client-side after retrieval. In production,
    // JanusGraph supports server-side text predicates via Elasticsearch,
    // but composing OR across multiple text properties requires the
    // anonymous-traversal API; for a gateway that's not the production
    // target today, JS post-filtering is simpler and adequate at our scale.
    const docs = await this.g!.V().hasLabel('Resource').toList();
    return queryResources(docs.map((v: any) => this.vertexToResource(v)), filter);
  }

  
  async createAnnotation(input: CreateAnnotationInternal): Promise<Annotation> {
    // The caller's id is the system of record's — never mint a fresh one
    // (the event-log id is what deletes and lookups arrive under).
    const annotation = buildAnnotation(input, new Date().toISOString());
    const props = encodeAnnotation(annotation);
    const targetSource = props.resourceId!;
    const bodySource = props.source;
    const entityTypes = getEntityTypes(input);

    // Create annotation vertex — every property comes from the codec, so a
    // source-only target contributes no `selector` property at all.
    let vertex = this.g!.addV('Annotation');
    for (const [key, value] of Object.entries(props)) {
      vertex = vertex.property(key, value);
    }

    const annVertex = await vertex.next();

    // Create edge from annotation to resource (BELONGS_TO)
    await this.g!
      .V(annVertex.value)
      .addE('BELONGS_TO')
      .to(this.g!.V().has('Resource', 'id', targetSource))
      .next();

    // If it's a resolved reference, create edge to target resource
    if (bodySource) {
      await this.g!
        .V(annVertex.value)
        .addE('REFERENCES')
        .to(this.g!.V().has('Resource', 'id', bodySource))
        .next();
    }

    // Create TAGGED_AS relationships for entity types
    for (const entityType of entityTypes) {
      // Get or create EntityType vertex
      const etResults = await this.g!
        .V()
        .has('EntityType', 'name', entityType)
        .toList();

      let etVertex;
      if (etResults.length === 0) {
        // Create new EntityType vertex
        etVertex = await this.g!
          .addV('EntityType')
          .property('name', entityType)
          .next();
      } else {
        etVertex = { value: etResults[0] };
      }

      // Create TAGGED_AS edge from Annotation to EntityType
      await this.g!
        .V(annVertex.value)
        .addE('TAGGED_AS')
        .to(this.g!.V(etVertex.value))
        .next();
    }

    this.logger?.info('Created annotation in JanusGraph', { id: annotation.id });
    return annotation;
  }
  
  async getAnnotation(id: AnnotationId): Promise<Annotation | null> {
    const vertices = await this.g!
      .V()
      .has('Annotation', 'id', id)
      .toList();

    if (vertices.length === 0) {
      return null;
    }

    // Fetch entity types from TAGGED_AS relationships
    const entityTypeVertices = await this.g!
      .V()
      .has('Annotation', 'id', id)
      .out('TAGGED_AS')
      .has('EntityType')
      .toList();

    const entityTypes = entityTypeVertices.map((v: any) =>
      getPropertyValue(v.properties || {}, 'name')
    ).filter(Boolean);

    return vertexToAnnotation(vertices[0] as any, entityTypes);
  }
  
  async updateAnnotation(id: AnnotationId, updates: Partial<Annotation>): Promise<Annotation> {
    const traversalQuery = this.g!
      .V()
      .has('Annotation', 'id', id);

    // Update target properties
    if (updates.target !== undefined && typeof updates.target !== 'string') {
      if (updates.target.selector !== undefined) {
        for (const [key, value] of Object.entries(encodeSelector(updates.target.selector))) {
          await traversalQuery.property(key, value).next();
        }
      }
    }

    // Update body properties and entity types
    if (updates.body !== undefined) {
      const bodySource = getBodySource(updates.body);
      const entityTypes = getEntityTypes({ body: updates.body });

      if (bodySource) {
        await traversalQuery.property('source', bodySource).next();
      }

      // Update entity type relationships - remove old ones and create new ones
      if (entityTypes.length >= 0) {
        // Remove existing TAGGED_AS edges
        await this.g!
          .V()
          .has('Annotation', 'id', id)
          .outE('TAGGED_AS')
          .drop()
          .iterate();

        // Create new TAGGED_AS edges
        for (const entityType of entityTypes) {
          // Get or create EntityType vertex
          const etResults = await this.g!
            .V()
            .has('EntityType', 'name', entityType)
            .toList();

          let etVertex;
          if (etResults.length === 0) {
            // Create new EntityType vertex
            etVertex = await this.g!
              .addV('EntityType')
              .property('name', entityType)
              .next();
          } else {
            etVertex = { value: etResults[0] };
          }

          // Create TAGGED_AS edge from Annotation to EntityType
          const annVertices = await this.g!
            .V()
            .has('Annotation', 'id', id)
            .toList();

          if (annVertices.length > 0) {
            await this.g!
              .V(annVertices[0])
              .addE('TAGGED_AS')
              .to(this.g!.V(etVertex.value))
              .next();
          }
        }
      }
    }

    if (updates.modified !== undefined) {
      await traversalQuery.property('modified', updates.modified).next();
    }
    if (updates.generator !== undefined) {
      await traversalQuery.property('generator', JSON.stringify(updates.generator)).next();
    }

    const updatedAnnotation = await this.getAnnotation(id);
    if (!updatedAnnotation) {
      throw new Error('Annotation not found');
    }

    return updatedAnnotation;
  }
  
  async deleteAnnotation(id: AnnotationId): Promise<void> {
    await this.g!
      .V()
      .has('Annotation', 'id', id)
      .drop()
      .next();

    this.logger?.info('Deleted annotation from JanusGraph', { id });
  }
  
  async listAnnotations(filter: { resourceId?: ResourceId; type?: AnnotationCategory }): Promise<{ annotations: Annotation[]; total: number }> {
    let traversalQuery = this.g!.V().hasLabel('Annotation');

    // Apply filters
    if (filter.resourceId) {
      traversalQuery = traversalQuery.has('resourceId', filter.resourceId);
    }

    if (filter.type) {
      traversalQuery = traversalQuery.has('type', storedAnnotationType(motivationForCategory(filter.type)));
    }

    const vertices = await traversalQuery.toList();
    const annotations = await this.fetchAnnotationsWithEntityTypes(vertices);

    return {
      annotations,
      total: annotations.length
    };
  }

  async getHighlights(resourceId: ResourceId): Promise<Annotation[]> {
    const { annotations } = await this.listAnnotations({
      resourceId,
      type: 'highlight'
    });
    return annotations;
  }

  async resolveReference(annotationId: AnnotationId, source: ResourceId): Promise<Annotation> {
    const annotation = await this.getAnnotation(annotationId);
    if (!annotation) throw new Error('Annotation not found');

    // TODO Preserve existing TextualBody entities, add SpecificResource
    // For now, just update with SpecificResource (losing entity tags)
    await this.updateAnnotation(annotationId, {
      body: [
        {
          type: 'SpecificResource',
          source,
          purpose: 'linking' as const,
        },
      ],
    });

    // Create edge from annotation to target resource
    await this.g!
      .V()
      .has('Annotation', 'id', annotationId)
      .addE('REFERENCES')
      .to(this.g!.V().has('Resource', 'id', source))
      .next();

    const updatedAnnotation = await this.getAnnotation(annotationId);
    if (!updatedAnnotation) {
      throw new Error('Annotation not found after update');
    }

    return updatedAnnotation;
  }

  async getReferences(resourceId: ResourceId): Promise<Annotation[]> {
    const { annotations } = await this.listAnnotations({
      resourceId,
      type: 'reference'
    });
    return annotations;
  }

  async getEntityReferences(resourceId: ResourceId, entityTypes?: string[]): Promise<Annotation[]> {
    const { annotations } = await this.listAnnotations({
      resourceId,
      type: 'reference'
    });

    // TODO Extract entity types from body using helper
    if (entityTypes && entityTypes.length > 0) {
      return annotations.filter(ann => {
        const annEntityTypes = getEntityTypes(ann);
        return annEntityTypes.some((type: string) => entityTypes.includes(type));
      });
    }

    return annotations.filter(ann => getEntityTypes(ann).length > 0);
  }

  async getResourceAnnotations(resourceId: ResourceId): Promise<Annotation[]> {
    const { annotations } = await this.listAnnotations({ resourceId });
    return annotations;
  }

  async getResourceReferencedBy(resourceId: ResourceId, _motivation?: string): Promise<Annotation[]> {
    // Find annotations that reference this resource
    const vertices = await this.g!
      .V()
      .hasLabel('Annotation')
      .has('source', resourceId)
      .toList();

    return this.fetchAnnotationsWithEntityTypes(vertices);
  }
  
  async getResourceConnections(resourceId: ResourceId): Promise<GraphConnection[]> {
    // Use Gremlin to find connected resources
    const paths = await this.g!
      .V()
      .has('Resource', 'id', resourceId)
      .inE('BELONGS_TO')
      .outV()
      .outE('REFERENCES')
      .inV()
      .path()
      .toList();

    // Convert paths to connections
    // This is simplified - real implementation would process paths properly
    this.logger?.debug('Found paths', { count: paths.length });

    // For now, also build connections from references
    const connections: GraphConnection[] = [];
    const refs = await this.getReferences(resourceId);

    for (const ref of refs) {
      // Extract source from body using helper
      const bodySource = getBodySource(ref.body);
      if (bodySource) {
        const targetDoc = await this.getResource(makeResourceId(bodySource));
        if (targetDoc) {
          const existing = connections.find(c => c.targetResource.id === targetDoc.id);
          if (existing) {
            existing.annotations.push(ref);
          } else {
            connections.push({
              targetResource: targetDoc,
              annotations: [ref],
              relationshipType: undefined,
              bidirectional: false,
            });
          }
        }
      }
    }

    return connections;
  }
  
  async findPath(_fromResourceId: string, _toResourceId: string, _maxDepth?: number): Promise<GraphPath[]> {
    // TODO: Implement real graph traversal with JanusGraph
    // For now, return empty array
    return [];
  }
  
  async getEntityTypeStats(): Promise<EntityTypeStats[]> {
    const docs = await this.g!.V().hasLabel('Resource').toList();
    const resources = docs.map((v: any) => this.vertexToResource(v));

    const stats = new Map<string, number>();

    for (const doc of resources) {
      for (const type of doc.entityTypes || []) {
        stats.set(type, (stats.get(type) || 0) + 1);
      }
    }

    return Array.from(stats.entries()).map(([type, count]) => ({ type, count }));
  }
  
  async getStats(): Promise<any> {
    const entityTypes: Record<string, number> = {};
    const contentTypes: Record<string, number> = {};

    // Get all resources
    const docs = await this.g!.V().hasLabel('Resource').toList();
    const resources = docs.map((v: any) => this.vertexToResource(v));

    for (const doc of resources) {
      for (const type of doc.entityTypes || []) {
        entityTypes[type] = (entityTypes[type] || 0) + 1;
      }
      const primaryRep = getPrimaryRepresentation(doc);
      if (primaryRep?.mediaType) {
        contentTypes[primaryRep.mediaType] = (contentTypes[primaryRep.mediaType] || 0) + 1;
      }
    }

    // Get all annotations
    const anns = await this.g!.V().hasLabel('Annotation').toList();
    const annotations = await this.fetchAnnotationsWithEntityTypes(anns);

    const highlights = annotations.filter(a => a.motivation === 'highlighting');
    const references = annotations.filter(a => a.motivation === 'linking');
    const entityReferences = references.filter(a => getEntityTypes(a).length > 0);

    return {
      resourceCount: resources.length,
      annotationCount: annotations.length,
      highlightCount: highlights.length,
      referenceCount: references.length,
      entityReferenceCount: entityReferences.length,
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
    const results = [];
    for (const input of inputs) {
      results.push(await this.createAnnotation(input));
    }
    return results;
  }

  async resolveReferences(inputs: Array<{ annotationId: AnnotationId; source: ResourceId }>): Promise<Annotation[]> {
    const results = [];
    for (const input of inputs) {
      results.push(await this.resolveReference(input.annotationId, input.source));
    }
    return results;
  }

  async detectAnnotations(_resourceId: ResourceId): Promise<Annotation[]> {
    // Auto-detection would analyze resource content
    return [];
  }
  
  async getEntityTypes(): Promise<string[]> {
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

    // Persist to JanusGraph
    try {
      // Find or create the TagCollection vertex
      const existing = await this.g!.V()
        .hasLabel('TagCollection')
        .has('type', 'entity-types')
        .toList();

      if (existing.length > 0) {
        // Update existing collection
        await this.g!.V(existing[0])
          .property('tags', JSON.stringify(Array.from(this.entityTypesCollection!)))
          .next();
      } else {
        // Create new collection
        await this.g!.addV('TagCollection')
          .property('type', 'entity-types')
          .property('tags', JSON.stringify(Array.from(this.entityTypesCollection!)))
          .next();
      }
    } catch (error) {
      this.logger?.error('Failed to add entity type', { error });
    }
  }

  async addEntityTypes(tags: string[]): Promise<void> {
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    tags.forEach(tag => this.entityTypesCollection!.add(tag));

    // Persist all at once
    try {
      const existing = await this.g!.V()
        .hasLabel('TagCollection')
        .has('type', 'entity-types')
        .toList();

      if (existing.length > 0) {
        await this.g!.V(existing[0])
          .property('tags', JSON.stringify(Array.from(this.entityTypesCollection!)))
          .next();
      } else {
        await this.g!.addV('TagCollection')
          .property('type', 'entity-types')
          .property('tags', JSON.stringify(Array.from(this.entityTypesCollection!)))
          .next();
      }
    } catch (error) {
      this.logger?.error('Failed to add entity types', { error });
    }
  }

  private async initializeTagCollections(): Promise<void> {
    // Load existing collections from JanusGraph
    const collections = await this.g!.V()
      .hasLabel('TagCollection')
      .toList();

    let entityTypesFromDb: string[] = [];

    for (const vertex of collections) {
      const props = (vertex as any).properties || {};
      const type = getPropertyValue(props, 'type');
      const tagsJson = getPropertyValue(props, 'tags');
      const tags = tagsJson ? JSON.parse(tagsJson) : [];

      if (type === 'entity-types') {
        entityTypesFromDb = tags;
      }
    }

    // Load defaults
    const { DEFAULT_ENTITY_TYPES } = await import('@semiont/ontology');

    // Merge with defaults
    this.entityTypesCollection = new Set([...DEFAULT_ENTITY_TYPES, ...entityTypesFromDb]);

    // Persist merged collection back to JanusGraph if it doesn't exist
    if (entityTypesFromDb.length === 0) {
      await this.addEntityTypes([]);
    }
  }

  generateId(): string {
    return uuidv4().replace(/-/g, '').substring(0, 12);
  }
  
  async clearDatabase(): Promise<void> {
    // Drop all vertices in JanusGraph
    await this.g!.V().drop().next();
    // Reset cached collections
    this.entityTypesCollection = null;
    this.logger?.info('Cleared JanusGraph database');
  }
}