// JanusGraph implementation with real Gremlin connection
// This replaces the mock in-memory implementation

import gremlin from 'gremlin';
import { GraphDatabase } from '../interface';
import { getEntityTypes, getBodySource } from '@semiont/api-client';
import type { components } from '@semiont/api-client';
import { getPrimaryRepresentation, getResourceId } from '../../utils/resource-helpers';
import type {
  AnnotationCategory,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  ResourceFilter,
  UpdateResourceInput,
  CreateAnnotationInternal,
  ResourceId,
  ResourceUri,
  AnnotationId,
  AnnotationUri,
  EnvironmentConfig,
} from '@semiont/core';
import { resourceUri } from '@semiont/core';
import { annotationIdToURI } from '../../lib/uri-utils';
import { getExactText } from '@semiont/api-client';
import { v4 as uuidv4 } from 'uuid';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];

const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;

export class JanusGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  private connection: gremlin.driver.DriverRemoteConnection | null = null;
  private g: gremlin.process.GraphTraversalSource | null = null;

  // Tag Collections - cached in memory for performance
  private entityTypesCollection: Set<string> | null = null;


  constructor(
    private graphConfig: {
      host?: string;
      port?: number;
      storageBackend?: 'cassandra' | 'hbase' | 'berkeleydb';
      indexBackend?: 'elasticsearch' | 'solr' | 'lucene';
    },
    private envConfig: EnvironmentConfig
  ) {}
  
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

    console.log(`Attempting to connect to JanusGraph at ws://${host}:${port}/gremlin`);

    this.connection = new DriverRemoteConnection(
      `ws://${host}:${port}/gremlin`,
      {}
    );

    this.g = traversal().withRemote(this.connection);

    // Test the connection with a simple query
    await this.g.V().limit(1).toList();

    this.connected = true;
    console.log('Successfully connected to JanusGraph');

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
    console.log('Schema initialization would happen here in production');
  }
  
  // Helper function to convert vertex to Resource
  private vertexToResource(vertex: any): ResourceDescriptor {
    const props = vertex.properties || {};
    const id = this.getPropertyValue(props, 'id');

    // Validate required fields
    const creatorRaw = this.getPropertyValue(props, 'creator');
    const creationMethod = this.getPropertyValue(props, 'creationMethod');
    const contentChecksum = this.getPropertyValue(props, 'contentChecksum');
    const mediaType = this.getPropertyValue(props, 'contentType');

    if (!creatorRaw) throw new Error(`Resource ${id} missing required field: creator`);
    if (!creationMethod) throw new Error(`Resource ${id} missing required field: creationMethod`);
    if (!contentChecksum) throw new Error(`Resource ${id} missing required field: contentChecksum`);
    if (!mediaType) throw new Error(`Resource ${id} missing required field: contentType`);

    const creator = typeof creatorRaw === 'string' ? JSON.parse(creatorRaw) : creatorRaw;

    const resource: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': id,
      name: this.getPropertyValue(props, 'name'),
      entityTypes: JSON.parse(this.getPropertyValue(props, 'entityTypes') || '[]'),
      representations: [{
        mediaType,
        checksum: contentChecksum,
        rel: 'original',
      }],
      archived: this.getPropertyValue(props, 'archived') === 'true',
      dateCreated: this.getPropertyValue(props, 'created'),
      wasAttributedTo: creator,
      creationMethod,
    };

    const sourceAnnotationId = this.getPropertyValue(props, 'sourceAnnotationId');
    const sourceResourceId = this.getPropertyValue(props, 'sourceResourceId');

    if (sourceAnnotationId) resource.sourceAnnotationId = sourceAnnotationId;
    if (sourceResourceId) resource.sourceResourceId = sourceResourceId;

    return resource;
  }
  
  // Helper to get property value from Gremlin vertex properties
  private getPropertyValue(props: any, key: string): any {
    if (!props[key]) return undefined;
    const prop = Array.isArray(props[key]) ? props[key][0] : props[key];
    return prop?.value || prop;
  }

  // Helper method to fetch annotations with their entity types
  private async fetchAnnotationsWithEntityTypes(annotationVertices: any[]): Promise<Annotation[]> {
    const annotations: Annotation[] = [];

    for (const vertex of annotationVertices) {
      const id = this.getPropertyValue(vertex.properties || {}, 'id');

      // Fetch entity types for this annotation
      const entityTypeVertices = await this.g!
        .V()
        .has('Annotation', 'id', id)
        .out('TAGGED_AS')
        .has('EntityType')
        .toList();

      const entityTypes = entityTypeVertices.map((v: any) =>
        this.getPropertyValue(v.properties || {}, 'name')
      ).filter(Boolean);

      annotations.push(this.vertexToAnnotation(vertex, entityTypes));
    }

    return annotations;
  }

  // Helper function to convert vertex to Annotation
  private vertexToAnnotation(vertex: any, entityTypes: string[] = []): Annotation {
    const props = vertex.properties || {};

    // Derive motivation from type if not present (backward compatibility)
    const motivation = this.getPropertyValue(props, 'motivation') || 'linking';

    // Parse creator - always stored as JSON string in DB
    const creatorJson = this.getPropertyValue(props, 'creator');
    const creator = JSON.parse(creatorJson);

    // Reconstruct body array from entity tags and linking body
    const bodyArray: Array<{type: 'TextualBody'; value: string; purpose: 'tagging'} | {type: 'SpecificResource'; source: string; purpose: 'linking'}> = [];

    // Add entity tag bodies (TextualBody with purpose: "tagging")
    for (const entityType of entityTypes) {
      if (entityType) {
        bodyArray.push({
          type: 'TextualBody' as const,
          value: entityType,
          purpose: 'tagging' as const,
        });
      }
    }

    // Add linking body (SpecificResource) if annotation is resolved
    const bodySource = this.getPropertyValue(props, 'source');
    if (bodySource) {
      bodyArray.push({
        type: 'SpecificResource' as const,
        source: bodySource,
        purpose: 'linking' as const,
      });
    }

    const annotation: Annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      id: this.getPropertyValue(props, 'id'),
      motivation,
      target: {
        source: this.getPropertyValue(props, 'resourceId'),
        selector: JSON.parse(this.getPropertyValue(props, 'selector') || '{}'),
      },
      body: bodyArray,
      creator,
      created: this.getPropertyValue(props, 'created'), // ISO string from DB
    };

    // W3C Web Annotation modification tracking
    const modified = this.getPropertyValue(props, 'modified');
    if (modified) {
      annotation.modified = modified;
    }

    const generatorJson = this.getPropertyValue(props, 'generator');
    if (generatorJson) {
      try {
        annotation.generator = JSON.parse(generatorJson);
      } catch (e) {
        // Ignore parse errors
      }
    }

    return annotation;
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
      .property('creationMethod', resource.creationMethod)
      .property('contentChecksum', primaryRep.checksum);

    if (resource.sourceAnnotationId) {
      vertex.property('sourceAnnotationId', resource.sourceAnnotationId);
    }
    if (resource.sourceResourceId) {
      vertex.property('sourceResourceId', resource.sourceResourceId);
    }

    await vertex.next();

    console.log('Created resource vertex in JanusGraph:', id);
    return resource;
  }
  
  async getResource(id: ResourceUri): Promise<ResourceDescriptor | null> {
    const vertices = await this.g!
      .V()
      .has('Resource', 'id', id)
      .toList();

    if (vertices.length === 0) {
      return null;
    }

    return this.vertexToResource(vertices[0] as any);
  }
  
  async updateResource(id: ResourceUri, input: UpdateResourceInput): Promise<ResourceDescriptor> {
    // Resources are immutable - only archiving is allowed
    if (Object.keys(input).length !== 1 || input.archived === undefined) {
      throw new Error('Resources are immutable. Only archiving is allowed.');
    }

    await this.g!
      .V()
      .has('Resource', 'id', id)
      .property('archived', input.archived)
      .next();

    const updatedResource = await this.getResource(id);
    if (!updatedResource) {
      throw new Error('Resource not found');
    }

    return updatedResource;
  }
  
  async deleteResource(id: ResourceUri): Promise<void> {
    // Delete the vertex and all its edges
    await this.g!
      .V()
      .has('Resource', 'id', id)
      .drop()
      .next();

    console.log('Deleted resource from JanusGraph:', id);
  }
  
  async listResources(filter: ResourceFilter): Promise<{ resources: ResourceDescriptor[]; total: number }> {
    let traversalQuery = this.g!.V().hasLabel('Resource');

    // Apply filters
    if (filter.search) {
      // Note: This is a simple text search. In production, you'd use
      // JanusGraph's full-text search capabilities with Elasticsearch
      traversalQuery = traversalQuery.has('name', gremlin.process.TextP.containing(filter.search));
    }

    const docs = await traversalQuery.toList();
    let resources = docs.map((v: any) => this.vertexToResource(v));

    // Apply entity type filtering after retrieval since JanusGraph stores as JSON
    if (filter.entityTypes && filter.entityTypes.length > 0) {
      resources = resources.filter(doc =>
        filter.entityTypes!.some(type => doc.entityTypes?.includes(type))
      );
    }

    const total = resources.length;
    const offset = filter.offset || 0;
    const limit = filter.limit || 50;

    return {
      resources: resources.slice(offset, offset + limit),
      total
    };
  }
  
  async searchResources(query: string, limit?: number): Promise<ResourceDescriptor[]> {
    const result = await this.listResources({ search: query, limit: limit || 10 });
    return result.resources;
  }
  
  async createAnnotation(input: CreateAnnotationInternal): Promise<Annotation> {
    const id = this.generateId();

    // Only linking motivation with SpecificResource or empty array (stub)
    const motivation = input.motivation;

    const annotation: Annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      id,
      motivation,
      target: input.target,
      body: input.body,
      creator: input.creator,
      created: new Date().toISOString(),
    };

    // Extract source from body using helper
    const bodySource = getBodySource(input.body);
    const entityTypes = getEntityTypes(input);
    const bodyType = Array.isArray(input.body) ? 'SpecificResource' : input.body.type;

    // Extract target source and selector
    const targetSource = typeof input.target === 'string' ? input.target : input.target.source;
    const targetSelector = typeof input.target === 'string' ? undefined : input.target.selector;

    // Create annotation vertex
    const vertex = this.g!
      .addV('Annotation')
      .property('id', id)
      .property('resourceId', targetSource) // Store full URI
      .property('text', targetSelector ? getExactText(targetSelector) : '')
      .property('selector', JSON.stringify(targetSelector || {}))
      .property('type', bodyType)
      .property('motivation', motivation)
      .property('creator', JSON.stringify(input.creator))
      .property('created', annotation.created);

    if (bodySource) {
      vertex.property('source', bodySource);
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

    console.log('Created annotation in JanusGraph:', id);
    return annotation;
  }
  
  async getAnnotation(id: AnnotationUri): Promise<Annotation | null> {
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
      this.getPropertyValue(v.properties || {}, 'name')
    ).filter(Boolean);

    return this.vertexToAnnotation(vertices[0] as any, entityTypes);
  }
  
  async updateAnnotation(id: AnnotationUri, updates: Partial<Annotation>): Promise<Annotation> {
    const traversalQuery = this.g!
      .V()
      .has('Annotation', 'id', id);

    // Update target properties
    if (updates.target !== undefined && typeof updates.target !== 'string') {
      if (updates.target.selector !== undefined) {
        await traversalQuery.property('text', getExactText(updates.target.selector)).next();
        await traversalQuery.property('selector', JSON.stringify(updates.target.selector)).next();
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
  
  async deleteAnnotation(id: AnnotationUri): Promise<void> {
    await this.g!
      .V()
      .has('Annotation', 'id', id)
      .drop()
      .next();

    console.log('Deleted annotation from JanusGraph:', id);
  }
  
  async listAnnotations(filter: { resourceId?: ResourceId; type?: AnnotationCategory }): Promise<{ annotations: Annotation[]; total: number }> {
    let traversalQuery = this.g!.V().hasLabel('Annotation');

    // Apply filters
    if (filter.resourceId) {
      traversalQuery = traversalQuery.has('resourceId', filter.resourceId);
    }

    if (filter.type) {
      const w3cType = filter.type === 'highlight' ? 'TextualBody' : 'SpecificResource';
      traversalQuery = traversalQuery.has('type', w3cType);
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
    const publicURL = this.envConfig.services.backend!.publicURL;
    const annotation = await this.getAnnotation(annotationIdToURI(annotationId, publicURL));
    if (!annotation) throw new Error('Annotation not found');

    // TODO Preserve existing TextualBody entities, add SpecificResource
    // For now, just update with SpecificResource (losing entity tags)
    await this.updateAnnotation(annotationIdToURI(annotationId, publicURL), {
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

    const updatedAnnotation = await this.getAnnotation(annotationIdToURI(annotationId, publicURL));
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

  async getResourceReferencedBy(resourceId: ResourceId): Promise<Annotation[]> {
    // Find annotations that reference this resource
    const vertices = await this.g!
      .V()
      .hasLabel('Annotation')
      .has('source', resourceId)
      .toList();

    return await this.fetchAnnotationsWithEntityTypes(vertices);
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
    console.log('Found paths:', paths.length);

    // For now, also build connections from references
    const connections: GraphConnection[] = [];
    const refs = await this.getReferences(resourceId);

    for (const ref of refs) {
      // Extract source from body using helper
      const bodySource = getBodySource(ref.body);
      if (bodySource) {
        const targetDoc = await this.getResource(resourceUri(bodySource));
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
      console.error('Failed to add entity type:', error);
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
      console.error('Failed to add entity types:', error);
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
      const type = this.getPropertyValue(props, 'type');
      const tagsJson = this.getPropertyValue(props, 'tags');
      const tags = tagsJson ? JSON.parse(tagsJson) : [];

      if (type === 'entity-types') {
        entityTypesFromDb = tags;
      }
    }

    // Load defaults
    const { DEFAULT_ENTITY_TYPES } = await import('../tag-collections');

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
    console.log('Cleared JanusGraph database');
  }
}