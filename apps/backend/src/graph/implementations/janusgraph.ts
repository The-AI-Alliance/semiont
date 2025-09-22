// JanusGraph implementation with real Gremlin connection
// This replaces the mock in-memory implementation

import gremlin from 'gremlin';
import { GraphDatabase } from '../interface';
import {
  Document,
  Selection,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  DocumentFilter,
  SelectionFilter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateSelectionInput,
  ResolveSelectionInput,
} from '../types';
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
      metadata: JSON.parse(this.getPropertyValue(props, 'metadata') || '{}'),
      archived: this.getPropertyValue(props, 'archived') === 'true',
      createdBy,
      createdAt: new Date(this.getPropertyValue(props, 'createdAt')),
      creationMethod,
      contentChecksum,
      sourceSelectionId: this.getPropertyValue(props, 'sourceSelectionId'),
      sourceDocumentId: this.getPropertyValue(props, 'sourceDocumentId'),
    };
  }
  
  // Helper to get property value from Gremlin vertex properties
  private getPropertyValue(props: any, key: string): any {
    if (!props[key]) return undefined;
    const prop = Array.isArray(props[key]) ? props[key][0] : props[key];
    return prop?.value || prop;
  }

  // Helper function to convert vertex to Selection
  private vertexToSelection(vertex: any): Selection {
    const props = vertex.properties || {};
    return {
      id: this.getPropertyValue(props, 'id'),
      documentId: this.getPropertyValue(props, 'documentId'),
      selectionType: this.getPropertyValue(props, 'selectionType'),
      selectionData: JSON.parse(this.getPropertyValue(props, 'selectionData') || '{}'),
      provisional: this.getPropertyValue(props, 'provisional') === 'true',
      createdAt: new Date(this.getPropertyValue(props, 'createdAt')),
      updatedAt: new Date(this.getPropertyValue(props, 'updatedAt')),
      createdBy: this.getPropertyValue(props, 'createdBy'),
      confidence: this.getPropertyValue(props, 'confidence'),
      metadata: JSON.parse(this.getPropertyValue(props, 'metadata') || '{}'),
      resolvedDocumentId: this.getPropertyValue(props, 'resolvedDocumentId'),
      resolvedAt: this.getPropertyValue(props, 'resolvedAt') ? new Date(this.getPropertyValue(props, 'resolvedAt')) : undefined,
      resolvedBy: this.getPropertyValue(props, 'resolvedBy'),
      referenceTags: JSON.parse(this.getPropertyValue(props, 'referenceTags') || '[]'),
      entityTypes: JSON.parse(this.getPropertyValue(props, 'entityTypes') || '[]'),
    };
  }
  
  async createDocument(input: CreateDocumentInput): Promise<Document> {
    const id = this.generateId();
    const now = new Date();

    const document: Document = {
      id,
      name: input.name,
      entityTypes: input.entityTypes,
      contentType: input.contentType,
      metadata: input.metadata,
      archived: false,
      createdAt: now,
      createdBy: input.createdBy,
      creationMethod: input.creationMethod,
      contentChecksum: input.contentChecksum,
      sourceSelectionId: input.sourceSelectionId,
      sourceDocumentId: input.sourceDocumentId,
    };

    // Create vertex in JanusGraph
    const vertex = this.g!
      .addV('Document')
      .property('id', id)
      .property('name', input.name)
      .property('entityTypes', JSON.stringify(input.entityTypes))
      .property('contentType', input.contentType)
      .property('metadata', JSON.stringify(input.metadata))
      .property('archived', false)
      .property('createdAt', now.toISOString())
      .property('createdBy', input.createdBy)
      .property('creationMethod', input.creationMethod)
      .property('contentChecksum', input.contentChecksum);

    if (input.sourceSelectionId) {
      vertex.property('sourceSelectionId', input.sourceSelectionId);
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
  
  async createSelection(input: CreateSelectionInput): Promise<Selection> {
    const id = this.generateId();
    const now = new Date();

    const selection: Selection = {
      id,
      documentId: input.documentId,
      selectionType: input.selectionType,
      selectionData: input.selectionData,
      provisional: input.provisional || false,
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy,
      confidence: input.confidence,
      metadata: input.metadata,
    };

    if ('resolvedDocumentId' in input) {
      selection.resolvedDocumentId = input.resolvedDocumentId;
      if (input.resolvedDocumentId) {
        selection.resolvedAt = now;
      }
      if (input.resolvedBy) selection.resolvedBy = input.resolvedBy;
    }

    if (input.referenceTags) selection.referenceTags = input.referenceTags;
    if (input.entityTypes) selection.entityTypes = input.entityTypes;

    // Create selection vertex
    const selVertex = await this.g!
      .addV('Selection')
      .property('id', id)
      .property('documentId', input.documentId)
      .property('selectionType', input.selectionType)
      .property('selectionData', JSON.stringify(input.selectionData))
      .property('provisional', input.provisional || false)
      .property('createdAt', now.toISOString())
      .property('updatedAt', now.toISOString())
      .next();

    // Create edge from selection to document (BELONGS_TO)
    await this.g!
      .V(selVertex.value)
      .addE('BELONGS_TO')
      .to(this.g!.V().has('Document', 'id', input.documentId))
      .next();

    // If it's a reference, create edge to target document
    if (input.resolvedDocumentId) {
      await this.g!
        .V(selVertex.value)
        .addE('REFERENCES')
        .to(this.g!.V().has('Document', 'id', input.resolvedDocumentId))
        .property('referenceTags', JSON.stringify(input.referenceTags || []))
        .next();
    }

    console.log('Created selection in JanusGraph:', id);
    return selection;
  }
  
  async getSelection(id: string): Promise<Selection | null> {
    const vertices = await this.g!
      .V()
      .has('Selection', 'id', id)
      .toList();

    if (vertices.length === 0) {
      return null;
    }

    return this.vertexToSelection(vertices[0] as any);
  }
  
  async updateSelection(id: string, updates: Partial<Selection>): Promise<Selection> {
    const traversalQuery = this.g!
      .V()
      .has('Selection', 'id', id);

    // Update properties
    if (updates.selectionData !== undefined) {
      await traversalQuery.property('selectionData', JSON.stringify(updates.selectionData)).next();
    }
    if (updates.provisional !== undefined) {
      await traversalQuery.property('provisional', updates.provisional).next();
    }
    if (updates.confidence !== undefined) {
      await traversalQuery.property('confidence', updates.confidence).next();
    }
    if (updates.metadata !== undefined) {
      await traversalQuery.property('metadata', JSON.stringify(updates.metadata)).next();
    }
    if (updates.resolvedDocumentId !== undefined) {
      await traversalQuery.property('resolvedDocumentId', updates.resolvedDocumentId).next();
    }
    if (updates.resolvedAt !== undefined) {
      await traversalQuery.property('resolvedAt', updates.resolvedAt.toISOString()).next();
    }
    if (updates.resolvedBy !== undefined) {
      await traversalQuery.property('resolvedBy', updates.resolvedBy).next();
    }
    if (updates.referenceTags !== undefined) {
      await traversalQuery.property('referenceTags', JSON.stringify(updates.referenceTags)).next();
    }
    if (updates.entityTypes !== undefined) {
      await traversalQuery.property('entityTypes', JSON.stringify(updates.entityTypes)).next();
    }

    await traversalQuery.property('updatedAt', new Date().toISOString()).next();

    const updatedSelection = await this.getSelection(id);
    if (!updatedSelection) {
      throw new Error('Selection not found');
    }

    return updatedSelection;
  }
  
  async deleteSelection(id: string): Promise<void> {
    await this.g!
      .V()
      .has('Selection', 'id', id)
      .drop()
      .next();

    console.log('Deleted selection from JanusGraph:', id);
  }
  
  async listSelections(filter: SelectionFilter): Promise<{ selections: Selection[]; total: number }> {
    let traversalQuery = this.g!.V().hasLabel('Selection');

    // Apply filters
    if (filter.documentId) {
      traversalQuery = traversalQuery.has('documentId', filter.documentId);
    }

    if (filter.resolvedDocumentId) {
      traversalQuery = traversalQuery.has('resolvedDocumentId', filter.resolvedDocumentId);
    }

    if (filter.provisional !== undefined) {
      traversalQuery = traversalQuery.has('provisional', filter.provisional);
    }

    const sels = await traversalQuery.toList();
    let selections = sels.map((v: any) => this.vertexToSelection(v));

    // Apply resolved filter after retrieval (since it's based on existence of resolvedDocumentId)
    if (filter.resolved !== undefined) {
      selections = selections.filter(sel => filter.resolved ? !!sel.resolvedDocumentId : !sel.resolvedDocumentId);
    }

    // Apply hasEntityTypes filter after retrieval
    if (filter.hasEntityTypes !== undefined) {
      selections = selections.filter(sel => filter.hasEntityTypes ? (sel.entityTypes && sel.entityTypes.length > 0) : (!sel.entityTypes || sel.entityTypes.length === 0));
    }

    const total = selections.length;
    const offset = filter.offset || 0;
    const limit = filter.limit || 50;

    return {
      selections: selections.slice(offset, offset + limit),
      total
    };
  }
  
  async getHighlights(documentId: string): Promise<Selection[]> {
    const { selections } = await this.listSelections({ 
      documentId, 
      resolved: false 
    });
    return selections;
  }
  
  async resolveSelection(input: ResolveSelectionInput): Promise<Selection> {
    const selection = await this.getSelection(input.selectionId);
    if (!selection) throw new Error('Selection not found');

    // Update the selection properties
    await this.updateSelection(input.selectionId, {
      resolvedDocumentId: input.documentId,
      resolvedAt: new Date(),
      resolvedBy: input.resolvedBy,
      referenceTags: input.referenceTags,
      entityTypes: input.entityTypes,
    });

    // Create edge from selection to target document
    if (input.documentId) {
      await this.g!
        .V()
        .has('Selection', 'id', input.selectionId)
        .addE('REFERENCES')
        .to(this.g!.V().has('Document', 'id', input.documentId))
        .property('referenceTags', JSON.stringify(input.referenceTags || []))
        .next();
    }

    const updatedSelection = await this.getSelection(input.selectionId);
    if (!updatedSelection) {
      throw new Error('Selection not found after update');
    }

    return updatedSelection;
  }
  
  async getReferences(documentId: string): Promise<Selection[]> {
    const { selections } = await this.listSelections({ 
      documentId, 
      resolved: true 
    });
    return selections;
  }
  
  async getEntityReferences(documentId: string, entityTypes?: string[]): Promise<Selection[]> {
    const { selections } = await this.listSelections({ 
      documentId, 
      resolved: true,
      hasEntityTypes: true 
    });
    
    if (entityTypes && entityTypes.length > 0) {
      return selections.filter(sel => 
        sel.entityTypes?.some(type => entityTypes.includes(type))
      );
    }
    
    return selections;
  }
  
  async getDocumentSelections(documentId: string): Promise<Selection[]> {
    const { selections } = await this.listSelections({ documentId });
    return selections;
  }
  
  async getDocumentReferencedBy(documentId: string): Promise<Selection[]> {
    const { selections } = await this.listSelections({ 
      resolvedDocumentId: documentId 
    });
    return selections;
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
      if (ref.resolvedDocumentId) {
        const targetDoc = await this.getDocument(ref.resolvedDocumentId);
        if (targetDoc) {
          const existing = connections.find(c => c.targetDocument.id === targetDoc.id);
          if (existing) {
            existing.selections.push(ref);
          } else {
            connections.push({
              targetDocument: targetDoc,
              selections: [ref],
              relationshipType: ref.referenceTags?.[0],
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

    // Get all selections
    const sels = await this.g!.V().hasLabel('Selection').toList();
    const selections = sels.map((v: any) => this.vertexToSelection(v));

    const highlights = selections.filter(s => !s.resolvedDocumentId);
    const references = selections.filter(s => s.resolvedDocumentId);
    const entityReferences = references.filter(s => s.entityTypes && s.entityTypes.length > 0);

    return {
      documentCount: documents.length,
      selectionCount: selections.length,
      highlightCount: highlights.length,
      referenceCount: references.length,
      entityReferenceCount: entityReferences.length,
      entityTypes,
      contentTypes,
    };
  }
  
  async createSelections(inputs: CreateSelectionInput[]): Promise<Selection[]> {
    const results = [];
    for (const input of inputs) {
      results.push(await this.createSelection(input));
    }
    return results;
  }
  
  async resolveSelections(inputs: ResolveSelectionInput[]): Promise<Selection[]> {
    const results = [];
    for (const input of inputs) {
      results.push(await this.resolveSelection(input));
    }
    return results;
  }
  
  async detectSelections(_documentId: string): Promise<Selection[]> {
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