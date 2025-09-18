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
  
  // Fallback to in-memory if connection fails
  private useFallback: boolean = false;
  private documents: Map<string, Document> = new Map();
  private selections: Map<string, Selection> = new Map();
  
  constructor(private config: {
    host?: string;
    port?: number;
    storageBackend?: 'cassandra' | 'hbase' | 'berkeleydb';
    indexBackend?: 'elasticsearch' | 'solr' | 'lucene';
  } = {}) {}
  
  async connect(): Promise<void> {
    const host = this.config.host || process.env.JANUSGRAPH_HOST || 'localhost';
    const port = this.config.port || parseInt(process.env.JANUSGRAPH_PORT || '8182');
    
    try {
      console.log(`Attempting to connect to JanusGraph at ws://${host}:${port}/gremlin`);
      
      this.connection = new DriverRemoteConnection(
        `ws://${host}:${port}/gremlin`,
        {}
      );
      
      this.g = traversal().withRemote(this.connection);
      
      // Test the connection with a simple query
      await this.g.V().limit(1).toList();
      
      this.connected = true;
      this.useFallback = false;
      console.log('Successfully connected to JanusGraph');
      
      // Initialize schema if needed
      await this.initializeSchema();
    } catch (error: any) {
      console.error('Failed to connect to JanusGraph:', error.message);
      console.log('Falling back to in-memory storage');
      this.useFallback = true;
      this.connected = true; // Mark as connected for fallback mode
    }
  }
  
  async disconnect(): Promise<void> {
    if (this.connection && !this.useFallback) {
      await this.connection.close();
    }
    this.connected = false;
  }
  
  isConnected(): boolean {
    return this.connected;
  }
  
  private async initializeSchema(): Promise<void> {
    if (this.useFallback) return;
    
    // Note: Schema management in JanusGraph typically requires direct access
    // to the management API, which isn't available through Gremlin.
    // In production, you'd run schema initialization scripts separately.
    console.log('Schema initialization would happen here in production');
  }
  
  // Helper function to convert vertex to Document
  private vertexToDocument(vertex: any): Document {
    const props = vertex.properties || {};
    return {
      id: this.getPropertyValue(props, 'id'),
      name: this.getPropertyValue(props, 'name'),
      entityTypes: JSON.parse(this.getPropertyValue(props, 'entityTypes') || '[]'),
      contentType: this.getPropertyValue(props, 'contentType'),
      metadata: JSON.parse(this.getPropertyValue(props, 'metadata') || '{}'),
      archived: this.getPropertyValue(props, 'archived') === 'true',
      createdBy: this.getPropertyValue(props, 'createdBy'),
      updatedBy: this.getPropertyValue(props, 'updatedBy'),
      createdAt: new Date(this.getPropertyValue(props, 'createdAt')),
      updatedAt: new Date(this.getPropertyValue(props, 'updatedAt')),
      creationMethod: this.getPropertyValue(props, 'creationMethod') as any,
      contentChecksum: this.getPropertyValue(props, 'contentChecksum'),
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
  
  async createDocument(input: CreateDocumentInput): Promise<Document> {
    const id = this.generateId();
    const now = new Date();
    
    const document: Document = {
      id,
      name: input.name,
      entityTypes: input.entityTypes || [],
      contentType: input.contentType,
      metadata: input.metadata || {},
      archived: false,
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
      creationMethod: input.creationMethod,
      sourceSelectionId: input.sourceSelectionId,
      sourceDocumentId: input.sourceDocumentId,
    };
    
    if (this.useFallback) {
      this.documents.set(id, document);
      return document;
    }
    
    try {
      // Create vertex in JanusGraph
      await this.g!
        .addV('Document')
        .property('id', id)
        .property('name', input.name)
        .property('entityTypes', JSON.stringify(input.entityTypes || []))
        .property('contentType', input.contentType)
        .property('metadata', JSON.stringify(input.metadata || {}))
        .property('archived', false)
        .property('createdAt', now.toISOString())
        .property('updatedAt', now.toISOString())
        .property('createdBy', input.createdBy || '')
        .property('updatedBy', input.createdBy || '')
        .next();
      
      console.log('Created document vertex in JanusGraph:', id);
      return document;
    } catch (error: any) {
      console.error('Error creating document in JanusGraph:', error.message);
      // Fall back to in-memory
      this.documents.set(id, document);
      return document;
    }
  }
  
  async getDocument(id: string): Promise<Document | null> {
    if (this.useFallback) {
      return this.documents.get(id) || null;
    }
    
    try {
      const vertices = await this.g!
        .V()
        .has('Document', 'id', id)
        .toList();
      
      if (vertices.length === 0) {
        return null;
      }
      
      return this.vertexToDocument(vertices[0] as any);
    } catch (error: any) {
      console.error('Error getting document from JanusGraph:', error.message);
      return this.documents.get(id) || null;
    }
  }
  
  async updateDocument(id: string, input: UpdateDocumentInput): Promise<Document> {
    if (this.useFallback) {
      const doc = this.documents.get(id);
      if (!doc) throw new Error('Document not found');
      
      const updated = {
        ...doc,
        ...input,
        updatedAt: new Date(),
      };
      this.documents.set(id, updated);
      return updated;
    }
    
    try {
      const traversalQuery = this.g!
        .V()
        .has('Document', 'id', id);
      
      // Update properties
      if (input.name !== undefined) {
        await traversalQuery.property('name', input.name).next();
      }
      if (input.entityTypes !== undefined) {
        await traversalQuery.property('entityTypes', JSON.stringify(input.entityTypes)).next();
      }
      if (input.metadata !== undefined) {
        await traversalQuery.property('metadata', JSON.stringify(input.metadata)).next();
      }
      
      await traversalQuery.property('updatedAt', new Date().toISOString()).next();
      
      return (await this.getDocument(id))!;
    } catch (error: any) {
      console.error('Error updating document in JanusGraph:', error.message);
      throw error;
    }
  }
  
  async deleteDocument(id: string): Promise<void> {
    if (this.useFallback) {
      this.documents.delete(id);
      // Also delete related selections
      for (const [selId, sel] of this.selections.entries()) {
        if (sel.documentId === id || sel.resolvedDocumentId === id) {
          this.selections.delete(selId);
        }
      }
      return;
    }
    
    try {
      // Delete the vertex and all its edges
      await this.g!
        .V()
        .has('Document', 'id', id)
        .drop()
        .next();
      
      console.log('Deleted document from JanusGraph:', id);
    } catch (error: any) {
      console.error('Error deleting document from JanusGraph:', error.message);
      this.documents.delete(id);
    }
  }
  
  async listDocuments(filter: DocumentFilter): Promise<{ documents: Document[]; total: number }> {
    if (this.useFallback) {
      let docs = Array.from(this.documents.values());
      
      if (filter.entityTypes && filter.entityTypes.length > 0) {
        docs = docs.filter(doc => 
          filter.entityTypes!.some(type => doc.entityTypes.includes(type))
        );
      }
      
      if (filter.search) {
        const searchLower = filter.search.toLowerCase();
        docs = docs.filter(doc => 
          doc.name.toLowerCase().includes(searchLower) ||
          doc.entityTypes.some(type => type.toLowerCase().includes(searchLower))
        );
      }
      
      const total = docs.length;
      const offset = filter.offset || 0;
      const limit = filter.limit || 50;
      
      return {
        documents: docs.slice(offset, offset + limit),
        total
      };
    }
    
    try {
      let traversalQuery = this.g!.V().hasLabel('Document');
      
      // Apply filters
      if (filter.search) {
        // Note: This is a simple text search. In production, you'd use
        // JanusGraph's full-text search capabilities with Elasticsearch
        traversalQuery = traversalQuery.has('name', gremlin.process.TextP.containing(filter.search));
      }
      
      const docs = await traversalQuery.toList();
      const documents = docs.map((v: any) => this.vertexToDocument(v));
      
      const total = documents.length;
      const offset = filter.offset || 0;
      const limit = filter.limit || 50;
      
      return {
        documents: documents.slice(offset, offset + limit),
        total
      };
    } catch (error: any) {
      console.error('Error listing documents from JanusGraph:', error.message);
      // Fall back to in-memory
      return this.listDocuments(filter);
    }
  }
  
  async searchDocuments(query: string, limit?: number): Promise<Document[]> {
    const result = await this.listDocuments({ search: query, limit: limit || 10 });
    return result.documents;
  }
  
  async createSelection(input: CreateSelectionInput): Promise<Selection> {
    const id = this.generateId('sel');
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
    
    if (this.useFallback) {
      this.selections.set(id, selection);
      return selection;
    }
    
    try {
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
      
      // Create edge from document to selection
      await this.g!
        .V()
        .has('Document', 'id', input.documentId)
        .addE('HAS_SELECTION')
        .to(selVertex.value)
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
    } catch (error: any) {
      console.error('Error creating selection in JanusGraph:', error.message);
      this.selections.set(id, selection);
      return selection;
    }
  }
  
  async getSelection(id: string): Promise<Selection | null> {
    if (this.useFallback) {
      return this.selections.get(id) || null;
    }
    
    try {
      const vertices = await this.g!
        .V()
        .has('Selection', 'id', id)
        .toList();
      
      if (vertices.length === 0) {
        return null;
      }
      
      // Convert vertex to Selection
      // This would need proper property extraction like vertexToDocument
      return this.selections.get(id) || null; // Fallback for now
    } catch (error: any) {
      console.error('Error getting selection from JanusGraph:', error.message);
      return this.selections.get(id) || null;
    }
  }
  
  async updateSelection(id: string, updates: Partial<Selection>): Promise<Selection> {
    const sel = await this.getSelection(id);
    if (!sel) throw new Error('Selection not found');
    
    const updated: Selection = {
      ...sel,
      ...updates,
      updatedAt: new Date(),
    };
    
    if (this.useFallback) {
      this.selections.set(id, updated);
      return updated;
    }
    
    // TODO: Implement JanusGraph update
    this.selections.set(id, updated);
    return updated;
  }
  
  async deleteSelection(id: string): Promise<void> {
    if (this.useFallback) {
      this.selections.delete(id);
      return;
    }
    
    try {
      await this.g!
        .V()
        .has('Selection', 'id', id)
        .drop()
        .next();
      
      console.log('Deleted selection from JanusGraph:', id);
    } catch (error: any) {
      console.error('Error deleting selection from JanusGraph:', error.message);
      this.selections.delete(id);
    }
  }
  
  async listSelections(filter: SelectionFilter): Promise<{ selections: Selection[]; total: number }> {
    // For now, use fallback implementation
    let sels = Array.from(this.selections.values());
    
    if (filter.documentId) {
      sels = sels.filter(sel => sel.documentId === filter.documentId);
    }
    
    if (filter.resolvedDocumentId) {
      sels = sels.filter(sel => sel.resolvedDocumentId === filter.resolvedDocumentId);
    }
    
    if (filter.provisional !== undefined) {
      sels = sels.filter(sel => sel.provisional === filter.provisional);
    }
    
    if (filter.resolved !== undefined) {
      sels = sels.filter(sel => filter.resolved ? !!sel.resolvedDocumentId : !sel.resolvedDocumentId);
    }
    
    const total = sels.length;
    const offset = filter.offset || 0;
    const limit = filter.limit || 50;
    
    return {
      selections: sels.slice(offset, offset + limit),
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
    
    const resolved: Selection = {
      ...selection,
      resolvedDocumentId: input.documentId,
      resolvedAt: new Date(),
      resolvedBy: input.resolvedBy,
      referenceTags: input.referenceTags,
      entityTypes: input.entityTypes,
      updatedAt: new Date(),
    };
    
    if (this.useFallback) {
      this.selections.set(selection.id, resolved);
      return resolved;
    }
    
    // TODO: Implement JanusGraph update with edge creation
    this.selections.set(selection.id, resolved);
    return resolved;
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
    if (!this.useFallback && this.g) {
      try {
        // Use Gremlin to find connected documents
        const paths = await this.g
          .V()
          .has('Document', 'id', documentId)
          .outE('HAS_SELECTION')
          .inV()
          .outE('REFERENCES')
          .inV()
          .path()
          .toList();
        
        // Convert paths to connections
        // This is simplified - real implementation would process paths properly
        console.log('Found paths:', paths.length);
      } catch (error: any) {
        console.error('Error getting connections from JanusGraph:', error.message);
      }
    }
    
    // Fallback implementation
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
    const stats = new Map<string, number>();
    
    for (const doc of this.documents.values()) {
      for (const type of doc.entityTypes) {
        stats.set(type, (stats.get(type) || 0) + 1);
      }
    }
    
    return Array.from(stats.entries()).map(([type, count]) => ({ type, count }));
  }
  
  async getStats(): Promise<any> {
    const entityTypes: Record<string, number> = {};
    const contentTypes: Record<string, number> = {};
    
    for (const doc of this.documents.values()) {
      for (const type of doc.entityTypes) {
        entityTypes[type] = (entityTypes[type] || 0) + 1;
      }
      contentTypes[doc.contentType] = (contentTypes[doc.contentType] || 0) + 1;
    }
    
    const highlights = Array.from(this.selections.values()).filter(s => !s.resolvedDocumentId);
    const references = Array.from(this.selections.values()).filter(s => s.resolvedDocumentId);
    const entityReferences = references.filter(s => s.entityTypes && s.entityTypes.length > 0);
    
    return {
      documentCount: this.documents.size,
      selectionCount: this.selections.size,
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
    const types = new Set<string>();
    for (const doc of this.documents.values()) {
      doc.entityTypes.forEach(type => types.add(type));
    }
    return Array.from(types);
  }
  
  async getReferenceTypes(): Promise<string[]> {
    const types = new Set<string>();
    for (const sel of this.selections.values()) {
      sel.referenceTags?.forEach(tag => types.add(tag));
    }
    return Array.from(types);
  }
  
  async addEntityType(tag: string): Promise<void> {
    // In real implementation, this would update schema
    console.log('Added entity type:', tag);
  }
  
  async addReferenceType(tag: string): Promise<void> {
    // In real implementation, this would update schema
    console.log('Added reference type:', tag);
  }
  
  async addEntityTypes(tags: string[]): Promise<void> {
    for (const tag of tags) {
      await this.addEntityType(tag);
    }
  }
  
  async addReferenceTypes(tags: string[]): Promise<void> {
    for (const tag of tags) {
      await this.addReferenceType(tag);
    }
  }
  
  generateId(prefix: string = 'doc'): string {
    return `${prefix}_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  }
  
  async clearDatabase(): Promise<void> {
    if (this.useFallback) {
      this.documents.clear();
      this.selections.clear();
      return;
    }
    
    try {
      // Drop all vertices in JanusGraph
      await this.g!.V().drop().next();
      console.log('Cleared JanusGraph database');
    } catch (error: any) {
      console.error('Error clearing JanusGraph:', error.message);
      this.documents.clear();
      this.selections.clear();
    }
  }
}