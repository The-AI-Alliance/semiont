// JanusGraph implementation with real Gremlin connection
// This replaces the mock in-memory implementation

import gremlin from 'gremlin';
import { GraphDatabase } from '../interface';
import {
  Document,
  Annotation,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  DocumentFilter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateAnnotationInternal,
} from '@semiont/core-types';
import { v4 as uuidv4 } from 'uuid';

const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;

export class JanusGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  private connection: gremlin.driver.DriverRemoteConnection | null = null;
  private g: gremlin.process.GraphTraversalSource | null = null;

  // Tag Collections - cached in memory for performance
  private entityTypesCollection: Set<string> | null = null;
  private referenceTypesCollection: Set<string> | null = null;


  constructor(private config: {
    host?: string;
    port?: number;
    storageBackend?: 'cassandra' | 'hbase' | 'berkeleydb';
    indexBackend?: 'elasticsearch' | 'solr' | 'lucene';
  } = {}) {}
  
  async connect(): Promise<void> {
    const host = this.config.host || process.env.JANUSGRAPH_HOST || 'localhost';
    const port = this.config.port || parseInt(process.env.JANUSGRAPH_PORT || '8182');

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
  
  // Helper function to convert vertex to Document
  private vertexToDocument(vertex: any): Document {
    const props = vertex.properties || {};
    const id = this.getPropertyValue(props, 'id');

    // Validate required fields
    const createdBy = this.getPropertyValue(props, 'createdBy');
    const creationMethod = this.getPropertyValue(props, 'creationMethod');
    const contentChecksum = this.getPropertyValue(props, 'contentChecksum');

    if (!createdBy) throw new Error(`Document ${id} missing required field: createdBy`);
    if (!creationMethod) throw new Error(`Document ${id} missing required field: creationMethod`);
    if (!contentChecksum) throw new Error(`Document ${id} missing required field: contentChecksum`);

    return {
      id,
      name: this.getPropertyValue(props, 'name'),
      entityTypes: JSON.parse(this.getPropertyValue(props, 'entityTypes') || '[]'),
      contentType: this.getPropertyValue(props, 'contentType'),
      archived: this.getPropertyValue(props, 'archived') === 'true',
      createdBy,
      createdAt: this.getPropertyValue(props, 'createdAt'), // ISO string from DB
      creationMethod,
      contentChecksum,
      sourceAnnotationId: this.getPropertyValue(props, 'sourceAnnotationId'),
      sourceDocumentId: this.getPropertyValue(props, 'sourceDocumentId'),
    };
  }
  
  // Helper to get property value from Gremlin vertex properties
  private getPropertyValue(props: any, key: string): any {
    if (!props[key]) return undefined;
    const prop = Array.isArray(props[key]) ? props[key][0] : props[key];
    return prop?.value || prop;
  }

  // Helper function to convert vertex to Annotation
  private vertexToAnnotation(vertex: any): Annotation {
    const props = vertex.properties || {};
    const annotation: Annotation = {
      id: this.getPropertyValue(props, 'id'),
      target: {
        source: this.getPropertyValue(props, 'documentId'),
        selector: JSON.parse(this.getPropertyValue(props, 'selector') || '{}'),
      },
      body: {
        type: this.getPropertyValue(props, 'type') as 'highlight' | 'reference',
        entityTypes: JSON.parse(this.getPropertyValue(props, 'entityTypes') || '[]'),
        referenceType: this.getPropertyValue(props, 'referenceType') || undefined,
        referencedDocumentId: this.getPropertyValue(props, 'referencedDocumentId') || undefined,
      },
      createdBy: this.getPropertyValue(props, 'createdBy'),
      createdAt: this.getPropertyValue(props, 'createdAt'), // ISO string from DB
    };

    if (this.getPropertyValue(props, 'resolvedDocumentName')) {
      annotation.resolvedDocumentName = this.getPropertyValue(props, 'resolvedDocumentName');
    }
    if (this.getPropertyValue(props, 'resolvedAt')) {
      annotation.resolvedAt = this.getPropertyValue(props, 'resolvedAt');
    }
    if (this.getPropertyValue(props, 'resolvedBy')) {
      annotation.resolvedBy = this.getPropertyValue(props, 'resolvedBy');
    }

    return annotation;
  }
  
  async createDocument(input: CreateDocumentInput): Promise<Document> {
    const id = this.generateId();
    const now = new Date().toISOString();

    const document: Document = {
      id,
      name: input.name,
      entityTypes: input.entityTypes,
      contentType: input.contentType,
      archived: false,
      createdAt: now,
      createdBy: input.createdBy,
      creationMethod: input.creationMethod,
      contentChecksum: input.contentChecksum,
      sourceAnnotationId: input.sourceAnnotationId,
      sourceDocumentId: input.sourceDocumentId,
    };

    // Create vertex in JanusGraph
    const vertex = this.g!
      .addV('Document')
      .property('id', id)
      .property('name', input.name)
      .property('entityTypes', JSON.stringify(input.entityTypes))
      .property('contentType', input.contentType)
      .property('archived', false)
      .property('createdAt', now)
      .property('createdBy', input.createdBy)
      .property('creationMethod', input.creationMethod)
      .property('contentChecksum', input.contentChecksum);

    if (input.sourceAnnotationId) {
      vertex.property('sourceAnnotationId', input.sourceAnnotationId);
    }
    if (input.sourceDocumentId) {
      vertex.property('sourceDocumentId', input.sourceDocumentId);
    }

    await vertex.next();

    console.log('Created document vertex in JanusGraph:', id);
    return document;
  }
  
  async getDocument(id: string): Promise<Document | null> {
    const vertices = await this.g!
      .V()
      .has('Document', 'id', id)
      .toList();

    if (vertices.length === 0) {
      return null;
    }

    return this.vertexToDocument(vertices[0] as any);
  }
  
  async updateDocument(id: string, input: UpdateDocumentInput): Promise<Document> {
    // Documents are immutable - only archiving is allowed
    if (Object.keys(input).length !== 1 || input.archived === undefined) {
      throw new Error('Documents are immutable. Only archiving is allowed.');
    }

    await this.g!
      .V()
      .has('Document', 'id', id)
      .property('archived', input.archived)
      .next();

    const updatedDocument = await this.getDocument(id);
    if (!updatedDocument) {
      throw new Error('Document not found');
    }

    return updatedDocument;
  }
  
  async deleteDocument(id: string): Promise<void> {
    // Delete the vertex and all its edges
    await this.g!
      .V()
      .has('Document', 'id', id)
      .drop()
      .next();

    console.log('Deleted document from JanusGraph:', id);
  }
  
  async listDocuments(filter: DocumentFilter): Promise<{ documents: Document[]; total: number }> {
    let traversalQuery = this.g!.V().hasLabel('Document');

    // Apply filters
    if (filter.search) {
      // Note: This is a simple text search. In production, you'd use
      // JanusGraph's full-text search capabilities with Elasticsearch
      traversalQuery = traversalQuery.has('name', gremlin.process.TextP.containing(filter.search));
    }

    const docs = await traversalQuery.toList();
    let documents = docs.map((v: any) => this.vertexToDocument(v));

    // Apply entity type filtering after retrieval since JanusGraph stores as JSON
    if (filter.entityTypes && filter.entityTypes.length > 0) {
      documents = documents.filter(doc =>
        filter.entityTypes!.some(type => doc.entityTypes.includes(type))
      );
    }

    const total = documents.length;
    const offset = filter.offset || 0;
    const limit = filter.limit || 50;

    return {
      documents: documents.slice(offset, offset + limit),
      total
    };
  }
  
  async searchDocuments(query: string, limit?: number): Promise<Document[]> {
    const result = await this.listDocuments({ search: query, limit: limit || 10 });
    return result.documents;
  }
  
  async createAnnotation(input: CreateAnnotationInternal): Promise<Annotation> {
    const id = this.generateId();

    const annotation: Annotation = {
      id,
      target: {
        source: input.target.source,
        selector: input.target.selector,
      },
      body: {
        type: input.body.type,
        entityTypes: input.body.entityTypes || [],
        referenceType: input.body.referenceType,
        referencedDocumentId: input.body.referencedDocumentId,
      },
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };

    // Create annotation vertex
    const vertex = this.g!
      .addV('Annotation')
      .property('id', id)
      .property('documentId', input.target.source)
      .property('text', input.target.selector.exact)
      .property('selector', JSON.stringify(input.target.selector))
      .property('type', input.body.type)
      .property('createdBy', input.createdBy)
      .property('createdAt', annotation.createdAt)
      .property('entityTypes', JSON.stringify(input.body.entityTypes || []));

    if (input.body.referenceType) {
      vertex.property('referenceType', input.body.referenceType);
    }
    if (input.body.referencedDocumentId) {
      vertex.property('referencedDocumentId', input.body.referencedDocumentId);
    }

    const annVertex = await vertex.next();

    // Create edge from annotation to document (BELONGS_TO)
    await this.g!
      .V(annVertex.value)
      .addE('BELONGS_TO')
      .to(this.g!.V().has('Document', 'id', input.target.source))
      .next();

    // If it's a reference, create edge to target document
    if (input.body.referencedDocumentId) {
      await this.g!
        .V(annVertex.value)
        .addE('REFERENCES')
        .to(this.g!.V().has('Document', 'id', input.body.referencedDocumentId))
        .next();
    }

    console.log('Created annotation in JanusGraph:', id);
    return annotation;
  }
  
  async getAnnotation(id: string): Promise<Annotation | null> {
    const vertices = await this.g!
      .V()
      .has('Annotation', 'id', id)
      .toList();

    if (vertices.length === 0) {
      return null;
    }

    return this.vertexToAnnotation(vertices[0] as any);
  }
  
  async updateAnnotation(id: string, updates: Partial<Annotation>): Promise<Annotation> {
    const traversalQuery = this.g!
      .V()
      .has('Annotation', 'id', id);

    // Update properties
    if (updates.target?.selector?.exact !== undefined) {
      await traversalQuery.property('text', updates.target?.selector?.exact).next();
    }
    if (updates.target?.selector !== undefined) {
      await traversalQuery.property('selector', JSON.stringify(updates.target?.selector)).next();
    }
    if (updates.body?.type !== undefined) {
      await traversalQuery.property('type', updates.body?.type).next();
    }
    if (updates.body?.referencedDocumentId !== undefined) {
      await traversalQuery.property('referencedDocumentId', updates.body?.referencedDocumentId).next();
    }
    if (updates.resolvedDocumentName !== undefined) {
      await traversalQuery.property('resolvedDocumentName', updates.resolvedDocumentName).next();
    }
    if (updates.resolvedAt !== undefined) {
      await traversalQuery.property('resolvedAt', updates.resolvedAt).next();
    }
    if (updates.resolvedBy !== undefined) {
      await traversalQuery.property('resolvedBy', updates.resolvedBy).next();
    }
    if (updates.body?.referenceType !== undefined) {
      await traversalQuery.property('referenceType', updates.body?.referenceType).next();
    }
    if (updates.body?.entityTypes !== undefined) {
      await traversalQuery.property('entityTypes', JSON.stringify(updates.body?.entityTypes)).next();
    }

    const updatedAnnotation = await this.getAnnotation(id);
    if (!updatedAnnotation) {
      throw new Error('Annotation not found');
    }

    return updatedAnnotation;
  }
  
  async deleteAnnotation(id: string): Promise<void> {
    await this.g!
      .V()
      .has('Annotation', 'id', id)
      .drop()
      .next();

    console.log('Deleted annotation from JanusGraph:', id);
  }
  
  async listAnnotations(filter: { documentId?: string; type?: 'highlight' | 'reference' }): Promise<{ annotations: Annotation[]; total: number }> {
    let traversalQuery = this.g!.V().hasLabel('Annotation');

    // Apply filters
    if (filter.documentId) {
      traversalQuery = traversalQuery.has('documentId', filter.documentId);
    }

    if (filter.type) {
      traversalQuery = traversalQuery.has('type', filter.type);
    }

    const vertices = await traversalQuery.toList();
    const annotations = vertices.map((v: any) => this.vertexToAnnotation(v));

    return {
      annotations,
      total: annotations.length
    };
  }

  async getHighlights(documentId: string): Promise<Annotation[]> {
    const { annotations } = await this.listAnnotations({
      documentId,
      type: 'highlight'
    });
    return annotations;
  }

  async resolveReference(annotationId: string, referencedDocumentId: string): Promise<Annotation> {
    const annotation = await this.getAnnotation(annotationId);
    if (!annotation) throw new Error('Annotation not found');

    // Get document name for resolvedDocumentName
    const targetDoc = await this.getDocument(referencedDocumentId);

    // Update the annotation properties
    await this.updateAnnotation(annotationId, {
      body: {
        type: 'reference',
        entityTypes: [],
        referencedDocumentId,
      },
      resolvedDocumentName: targetDoc?.name,
      resolvedAt: new Date().toISOString(),
    });

    // Create edge from annotation to target document
    await this.g!
      .V()
      .has('Annotation', 'id', annotationId)
      .addE('REFERENCES')
      .to(this.g!.V().has('Document', 'id', referencedDocumentId))
      .next();

    const updatedAnnotation = await this.getAnnotation(annotationId);
    if (!updatedAnnotation) {
      throw new Error('Annotation not found after update');
    }

    return updatedAnnotation;
  }

  async getReferences(documentId: string): Promise<Annotation[]> {
    const { annotations } = await this.listAnnotations({
      documentId,
      type: 'reference'
    });
    return annotations;
  }

  async getEntityReferences(documentId: string, entityTypes?: string[]): Promise<Annotation[]> {
    const { annotations } = await this.listAnnotations({
      documentId,
      type: 'reference'
    });

    if (entityTypes && entityTypes.length > 0) {
      return annotations.filter(ann =>
        ann.body.entityTypes?.some((type: string) => entityTypes.includes(type))
      );
    }

    return annotations.filter(ann => ann.body.entityTypes && ann.body.entityTypes.length > 0);
  }

  async getDocumentAnnotations(documentId: string): Promise<Annotation[]> {
    const { annotations } = await this.listAnnotations({ documentId });
    return annotations;
  }

  async getDocumentReferencedBy(documentId: string): Promise<Annotation[]> {
    // Find annotations that reference this document
    const vertices = await this.g!
      .V()
      .hasLabel('Annotation')
      .has('referencedDocumentId', documentId)
      .toList();

    return vertices.map((v: any) => this.vertexToAnnotation(v));
  }
  
  async getDocumentConnections(documentId: string): Promise<GraphConnection[]> {
    // Use Gremlin to find connected documents
    const paths = await this.g!
      .V()
      .has('Document', 'id', documentId)
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
    const refs = await this.getReferences(documentId);

    for (const ref of refs) {
      if (ref.body.referencedDocumentId) {
        const targetDoc = await this.getDocument(ref.body.referencedDocumentId);
        if (targetDoc) {
          const existing = connections.find(c => c.targetDocument.id === targetDoc.id);
          if (existing) {
            existing.annotations.push(ref);
          } else {
            connections.push({
              targetDocument: targetDoc,
              annotations: [ref],
              relationshipType: ref.body.referenceType,
              bidirectional: false,
            });
          }
        }
      }
    }

    return connections;
  }
  
  async findPath(_fromDocumentId: string, _toDocumentId: string, _maxDepth?: number): Promise<GraphPath[]> {
    // TODO: Implement real graph traversal with JanusGraph
    // For now, return empty array
    return [];
  }
  
  async getEntityTypeStats(): Promise<EntityTypeStats[]> {
    const docs = await this.g!.V().hasLabel('Document').toList();
    const documents = docs.map((v: any) => this.vertexToDocument(v));

    const stats = new Map<string, number>();

    for (const doc of documents) {
      for (const type of doc.entityTypes) {
        stats.set(type, (stats.get(type) || 0) + 1);
      }
    }

    return Array.from(stats.entries()).map(([type, count]) => ({ type, count }));
  }
  
  async getStats(): Promise<any> {
    const entityTypes: Record<string, number> = {};
    const contentTypes: Record<string, number> = {};

    // Get all documents
    const docs = await this.g!.V().hasLabel('Document').toList();
    const documents = docs.map((v: any) => this.vertexToDocument(v));

    for (const doc of documents) {
      for (const type of doc.entityTypes) {
        entityTypes[type] = (entityTypes[type] || 0) + 1;
      }
      contentTypes[doc.contentType] = (contentTypes[doc.contentType] || 0) + 1;
    }

    // Get all annotations
    const anns = await this.g!.V().hasLabel('Annotation').toList();
    const annotations = anns.map((v: any) => this.vertexToAnnotation(v));

    const highlights = annotations.filter(a => a.body.type === 'highlight');
    const references = annotations.filter(a => a.body.type === 'reference');
    const entityReferences = references.filter(a => a.body.entityTypes && a.body.entityTypes.length > 0);

    return {
      documentCount: documents.length,
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

  async resolveReferences(inputs: Array<{ annotationId: string; referencedDocumentId: string }>): Promise<Annotation[]> {
    const results = [];
    for (const input of inputs) {
      results.push(await this.resolveReference(input.annotationId, input.referencedDocumentId));
    }
    return results;
  }

  async detectAnnotations(_documentId: string): Promise<Annotation[]> {
    // Auto-detection would analyze document content
    return [];
  }
  
  async getEntityTypes(): Promise<string[]> {
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    return Array.from(this.entityTypesCollection!).sort();
  }
  
  async getReferenceTypes(): Promise<string[]> {
    if (this.referenceTypesCollection === null) {
      await this.initializeTagCollections();
    }
    return Array.from(this.referenceTypesCollection!).sort();
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
  
  async addReferenceType(tag: string): Promise<void> {
    if (this.referenceTypesCollection === null) {
      await this.initializeTagCollections();
    }
    this.referenceTypesCollection!.add(tag);

    // Persist to JanusGraph
    try {
      // Find or create the TagCollection vertex
      const existing = await this.g!.V()
        .hasLabel('TagCollection')
        .has('type', 'reference-types')
        .toList();

      if (existing.length > 0) {
        // Update existing collection
        await this.g!.V(existing[0])
          .property('tags', JSON.stringify(Array.from(this.referenceTypesCollection!)))
          .next();
      } else {
        // Create new collection
        await this.g!.addV('TagCollection')
          .property('type', 'reference-types')
          .property('tags', JSON.stringify(Array.from(this.referenceTypesCollection!)))
          .next();
      }
    } catch (error) {
      console.error('Failed to add reference type:', error);
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
  
  async addReferenceTypes(tags: string[]): Promise<void> {
    if (this.referenceTypesCollection === null) {
      await this.initializeTagCollections();
    }
    tags.forEach(tag => this.referenceTypesCollection!.add(tag));

    // Persist all at once
    try {
      const existing = await this.g!.V()
        .hasLabel('TagCollection')
        .has('type', 'reference-types')
        .toList();

      if (existing.length > 0) {
        await this.g!.V(existing[0])
          .property('tags', JSON.stringify(Array.from(this.referenceTypesCollection!)))
          .next();
      } else {
        await this.g!.addV('TagCollection')
          .property('type', 'reference-types')
          .property('tags', JSON.stringify(Array.from(this.referenceTypesCollection!)))
          .next();
      }
    } catch (error) {
      console.error('Failed to add reference types:', error);
    }
  }
  
  private async initializeTagCollections(): Promise<void> {
    // Load existing collections from JanusGraph
    const collections = await this.g!.V()
      .hasLabel('TagCollection')
      .toList();

    let entityTypesFromDb: string[] = [];
    let referenceTypesFromDb: string[] = [];

    for (const vertex of collections) {
      const props = (vertex as any).properties || {};
      const type = this.getPropertyValue(props, 'type');
      const tagsJson = this.getPropertyValue(props, 'tags');
      const tags = tagsJson ? JSON.parse(tagsJson) : [];

      if (type === 'entity-types') {
        entityTypesFromDb = tags;
      } else if (type === 'reference-types') {
        referenceTypesFromDb = tags;
      }
    }

    // Load defaults
    const { DEFAULT_ENTITY_TYPES, DEFAULT_REFERENCE_TYPES } = await import('../tag-collections');

    // Merge with defaults
    this.entityTypesCollection = new Set([...DEFAULT_ENTITY_TYPES, ...entityTypesFromDb]);
    this.referenceTypesCollection = new Set([...DEFAULT_REFERENCE_TYPES, ...referenceTypesFromDb]);

    // Persist merged collections back to JanusGraph if they don't exist
    if (entityTypesFromDb.length === 0) {
      await this.addEntityTypes([]);
    }
    if (referenceTypesFromDb.length === 0) {
      await this.addReferenceTypes([]);
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
    this.referenceTypesCollection = null;
    console.log('Cleared JanusGraph database');
  }
}