// JanusGraph implementation of GraphDatabase interface
// Uses Gremlin for graph traversal (like Neptune) but with JanusGraph-specific features

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
  SaveSelectionInput,
  ResolveSelectionInput,
  isHighlight,
  isReference,
  isEntityReference,
} from '../types';
import { v4 as uuidv4 } from 'uuid';

// Note: In production, you would use gremlin libraries with JanusGraph server
// JanusGraph supports multiple storage backends (Cassandra, HBase, BerkeleyDB)

export class JanusGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  // private client: any; // Would be Gremlin client in production
  
  // In-memory storage for development/testing (same as Neptune/Neo4j for now)
  private documents: Map<string, Document> = new Map();
  private selections: Map<string, Selection> = new Map();
  
  constructor(config: {
    host?: string;
    port?: number;
    storageBackend?: 'cassandra' | 'hbase' | 'berkeleydb';
    indexBackend?: 'elasticsearch' | 'solr' | 'lucene';
  } = {}) {
    // Config will be used when implementing actual JanusGraph connection
    void config;
  }
  
  async connect(): Promise<void> {
    // In production: connect to JanusGraph server using Gremlin
    // const gremlin = require('gremlin');
    // this.client = new gremlin.driver.Client(
    //   `ws://${this.config.host || 'localhost'}:${this.config.port || 8182}/gremlin`,
    //   { traversalSource: 'g' }
    // );
    // 
    // JanusGraph specific: Initialize schema if needed
    // await this.initializeSchema();
    
    console.log('Connecting to JanusGraph (simulated)...');
    this.connected = true;
  }
  
  async disconnect(): Promise<void> {
    // In production: close Gremlin connection
    // if (this.client) await this.client.close();
    this.connected = false;
  }
  
  isConnected(): boolean {
    return this.connected;
  }
  
  // JanusGraph specific: Schema management
  // private async initializeSchema(): Promise<void> {
  //   // In production: Define vertex labels, edge labels, and property keys
  //   // await this.client.submit(`
  //   //   mgmt = graph.openManagement()
  //   //   
  //   //   // Define vertex labels
  //   //   if (!mgmt.containsVertexLabel('Document')) {
  //   //     mgmt.makeVertexLabel('Document').make()
  //   //   }
  //   //   
  //   //   // Define edge labels
  //   //   if (!mgmt.containsEdgeLabel('REFERENCES')) {
  //   //     mgmt.makeEdgeLabel('REFERENCES').multiplicity(MULTI).make()
  //   //   }
  //   //   
  //   //   // Define property keys
  //   //   if (!mgmt.containsPropertyKey('name')) {
  //   //     mgmt.makePropertyKey('name').dataType(String.class).cardinality(SINGLE).make()
  //   //   }
  //   //   
  //   //   // Create indexes for better query performance
  //   //   if (!mgmt.containsGraphIndex('documentByName')) {
  //   //     name = mgmt.getPropertyKey('name')
  //   //     mgmt.buildIndex('documentByName', Vertex.class).addKey(name).buildCompositeIndex()
  //   //   }
  //   //   
  //   //   // Create mixed index for full-text search (requires indexing backend)
  //   //   if (!mgmt.containsGraphIndex('documentSearch')) {
  //   //     mgmt.buildIndex('documentSearch', Vertex.class)
  //   //       .addKey(name, Mapping.TEXT.asParameter())
  //   //       .buildMixedIndex('search')
  //   //   }
  //   //   
  //   //   mgmt.commit()
  //   // `);
  // }
  
  async createDocument(input: CreateDocumentInput): Promise<Document> {
    const id = this.generateId();
    const now = new Date();
    
    const document: Document = {
      id,
      name: input.name,
      entityTypes: input.entityTypes || [],
      contentType: input.contentType,
      storageUrl: `/efs/documents/${id}`,
      metadata: input.metadata || {},
      archived: false,  // New documents are not archived by default
      createdAt: now,
      updatedAt: now,
    };
    
    // Audit fields
    if (input.createdBy) document.createdBy = input.createdBy;
    if (input.createdBy) document.updatedBy = input.createdBy;
    
    // Provenance tracking fields
    if (input.creationMethod) document.creationMethod = input.creationMethod;
    if (input.sourceSelectionId) document.sourceSelectionId = input.sourceSelectionId;
    if (input.sourceDocumentId) document.sourceDocumentId = input.sourceDocumentId;
    // Note: contentChecksum should be in metadata, set by the routes layer
    
    // In production: Use Gremlin to create vertex with JanusGraph transaction
    // await this.client.submit(`
    //   graph.tx().rollback()
    //   g.addV('Document')
    //     .property('id', id)
    //     .property('name', name)
    //     .property('entityTypes', entityTypes)
    //     .property('contentType', contentType)
    //     .property('storageUrl', storageUrl)
    //     .property('createdAt', createdAt)
    //     .property('updatedAt', updatedAt)
    //   graph.tx().commit()
    // `, { id, name, entityTypes, ... });
    
    this.documents.set(id, document);
    return document;
  }
  
  async getDocument(id: string): Promise<Document | null> {
    // In production: Use Gremlin to query vertex
    // const result = await this.client.submit(`
    //   g.V().hasLabel('Document').has('id', id).valueMap(true)
    // `, { id });
    
    return this.documents.get(id) || null;
  }
  
  async updateDocument(id: string, input: UpdateDocumentInput): Promise<Document> {
    const doc = this.documents.get(id);
    if (!doc) throw new Error('Document not found');
    
    const updated: Document = {
      ...doc,
      ...(input.name && { name: input.name }),
      ...(input.entityTypes && { entityTypes: input.entityTypes }),
      ...(input.metadata && { metadata: { ...doc.metadata, ...input.metadata } }),
      ...(input.archived !== undefined && { archived: input.archived }),
      ...(input.updatedBy && { updatedBy: input.updatedBy }),
      updatedAt: new Date(),
    };
    
    // In production: Use Gremlin with JanusGraph transaction
    // await this.client.submit(`
    //   graph.tx().rollback()
    //   g.V().has('id', id)
    //     .property('name', name)
    //     .property('entityTypes', entityTypes)
    //     .property('updatedAt', new Date())
    //   graph.tx().commit()
    // `, { id, name, entityTypes, ... });
    
    this.documents.set(id, updated);
    return updated;
  }
  
  async deleteDocument(id: string): Promise<void> {
    // In production: Use Gremlin to delete vertex and edges
    // await this.client.submit(`
    //   graph.tx().rollback()
    //   g.V().has('id', id).drop()
    //   graph.tx().commit()
    // `, { id });
    
    this.documents.delete(id);
    
    // Delete selections
    for (const [selId, sel] of this.selections) {
      if (sel.documentId === id || sel.resolvedDocumentId === id) {
        this.selections.delete(selId);
      }
    }
  }
  
  async listDocuments(filter: DocumentFilter): Promise<{ documents: Document[]; total: number }> {
    let docs = Array.from(this.documents.values());
    
    if (filter.entityTypes && filter.entityTypes.length > 0) {
      docs = docs.filter(doc => 
        doc.entityTypes.some(type => filter.entityTypes!.includes(type))
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
    
    return { documents: docs, total };
  }
  
  async searchDocuments(query: string, limit: number = 20): Promise<Document[]> {
    // In production: Use JanusGraph's mixed index for full-text search
    // const results = await this.client.submit(`
    //   g.V().has('Document', 'name', textContains(query)).limit(limit).valueMap(true)
    // `, { query, limit });
    
    const searchLower = query.toLowerCase();
    const results = Array.from(this.documents.values())
      .filter(doc => doc.name.toLowerCase().includes(searchLower))
      .slice(0, limit);
    
    return results;
  }
  
  async createSelection(input: CreateSelectionInput): Promise<Selection> {
    const id = this.generateId('sel');
    const now = new Date();
    
    const selection: Selection = {
      id,
      documentId: input.documentId,
      selectionType: input.selectionType,
      selectionData: input.selectionData,
      saved: input.saved || false,
      provisional: input.provisional || false,
      createdAt: now,
      updatedAt: now,
    };
    
    if (input.savedBy) {
      selection.savedBy = input.savedBy;
      selection.savedAt = now;
    }
    
    if (input.resolvedDocumentId) {
      selection.resolvedDocumentId = input.resolvedDocumentId;
      selection.resolvedAt = now;
      if (input.resolvedBy) selection.resolvedBy = input.resolvedBy;
    }
    
    if (input.referenceTags) selection.referenceTags = input.referenceTags;
    if (input.entityTypes) selection.entityTypes = input.entityTypes;
    if (input.confidence !== undefined) selection.confidence = input.confidence;
    if (input.metadata) selection.metadata = input.metadata;
    
    // In production: Create edge in graph with properties
    // await this.client.submit(`
    //   graph.tx().rollback()
    //   g.V().has('id', documentId).as('from')
    //     .V().has('id', resolvedDocumentId).as('to')
    //     .addE('REFERENCES').from('from').to('to')
    //     .property('id', id)
    //     .property('selectionType', selectionType)
    //     .property('saved', saved)
    //     .property('provisional', provisional)
    //     .property('confidence', confidence)
    //   graph.tx().commit()
    // `, { documentId, resolvedDocumentId, ... });
    
    this.selections.set(id, selection);
    return selection;
  }
  
  async getSelection(id: string): Promise<Selection | null> {
    return this.selections.get(id) || null;
  }
  
  async updateSelection(id: string, updates: Partial<Selection>): Promise<Selection> {
    const sel = this.selections.get(id);
    if (!sel) throw new Error('Selection not found');
    
    const updated: Selection = {
      ...sel,
      ...updates,
      updatedAt: new Date(),
    };
    
    this.selections.set(id, updated);
    return updated;
  }
  
  async deleteSelection(id: string): Promise<void> {
    this.selections.delete(id);
  }
  
  async listSelections(filter: SelectionFilter): Promise<{ selections: Selection[]; total: number }> {
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
    
    if (filter.saved !== undefined) {
      sels = sels.filter(sel => sel.saved === filter.saved);
    }
    
    if (filter.resolved !== undefined) {
      sels = sels.filter(sel => filter.resolved ? !!sel.resolvedDocumentId : !sel.resolvedDocumentId);
    }
    
    if (filter.hasEntityTypes !== undefined) {
      sels = sels.filter(sel => filter.hasEntityTypes ? 
        (sel.entityTypes && sel.entityTypes.length > 0) : 
        (!sel.entityTypes || sel.entityTypes.length === 0)
      );
    }
    
    if (filter.referenceTags && filter.referenceTags.length > 0) {
      sels = sels.filter(sel => 
        sel.referenceTags && sel.referenceTags.some(tag => filter.referenceTags!.includes(tag))
      );
    }
    
    const total = sels.length;
    const offset = filter.offset || 0;
    const limit = filter.limit || 20;
    sels = sels.slice(offset, offset + limit);
    
    return { selections: sels, total };
  }
  
  async saveSelection(input: SaveSelectionInput): Promise<Selection> {
    const sel = this.selections.get(input.selectionId);
    if (!sel) throw new Error('Selection not found');
    
    const updated: Selection = {
      ...sel,
      saved: true,
      savedAt: new Date(),
      updatedAt: new Date(),
    };
    
    if (input.savedBy) updated.savedBy = input.savedBy;
    if (input.metadata || sel.metadata) {
      updated.metadata = { ...sel.metadata, ...input.metadata };
    }
    
    this.selections.set(input.selectionId, updated);
    return updated;
  }
  
  async getHighlights(documentId: string): Promise<Selection[]> {
    return Array.from(this.selections.values())
      .filter(sel => sel.documentId === documentId && sel.saved && !sel.resolvedDocumentId);
  }
  
  async resolveSelection(input: ResolveSelectionInput): Promise<Selection> {
    const sel = this.selections.get(input.selectionId);
    if (!sel) throw new Error('Selection not found');
    
    const updated: Selection = {
      ...sel,
      resolvedDocumentId: input.documentId,
      provisional: input.provisional || false,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    };
    
    if (input.referenceTags) updated.referenceTags = input.referenceTags;
    if (input.entityTypes) updated.entityTypes = input.entityTypes;
    if (input.confidence !== undefined) updated.confidence = input.confidence;
    if (input.resolvedBy) updated.resolvedBy = input.resolvedBy;
    if (input.metadata || sel.metadata) {
      updated.metadata = { ...sel.metadata, ...input.metadata };
    }
    
    this.selections.set(input.selectionId, updated);
    return updated;
  }
  
  async getReferences(documentId: string): Promise<Selection[]> {
    return Array.from(this.selections.values())
      .filter(sel => sel.documentId === documentId && !!sel.resolvedDocumentId);
  }
  
  async getEntityReferences(documentId: string, entityTypes?: string[]): Promise<Selection[]> {
    let refs = Array.from(this.selections.values())
      .filter(sel => sel.documentId === documentId && isEntityReference(sel));
    
    if (entityTypes && entityTypes.length > 0) {
      refs = refs.filter(sel => 
        sel.entityTypes && sel.entityTypes.some(type => entityTypes.includes(type))
      );
    }
    
    return refs;
  }
  
  async getDocumentSelections(documentId: string): Promise<Selection[]> {
    return Array.from(this.selections.values())
      .filter(sel => sel.documentId === documentId);
  }
  
  async getDocumentReferencedBy(documentId: string): Promise<Selection[]> {
    return Array.from(this.selections.values())
      .filter(sel => sel.resolvedDocumentId === documentId);
  }
  
  async getDocumentConnections(documentId: string): Promise<GraphConnection[]> {
    // In production: Use Gremlin traversal with JanusGraph optimizations
    // const results = await this.client.submit(`
    //   g.V().has('id', documentId)
    //     .bothE('REFERENCES').as('e')
    //     .otherV().as('v')
    //     .select('e', 'v')
    // `, { documentId });
    
    const connections: GraphConnection[] = [];
    const refs = await this.getReferences(documentId);
    
    for (const ref of refs) {
      if (ref.resolvedDocumentId) {
        const targetDoc = await this.getDocument(ref.resolvedDocumentId);
        if (targetDoc) {
          const reverseRefs = await this.getReferences(ref.resolvedDocumentId);
          const bidirectional = reverseRefs.some(r => r.resolvedDocumentId === documentId);
          
          connections.push({
            targetDocument: targetDoc,
            selections: [ref],
            bidirectional,
          });
        }
      }
    }
    
    return connections;
  }
  
  async findPath(fromDocumentId: string, toDocumentId: string, maxDepth: number = 5): Promise<GraphPath[]> {
    // In production: Use JanusGraph's optimized path queries
    // const results = await this.client.submit(`
    //   g.V().has('id', fromDocumentId)
    //     .repeat(both().simplePath()).times(maxDepth).emit()
    //     .has('id', toDocumentId)
    //     .path()
    //     .by(valueMap(true))
    //     .limit(10)
    // `, { fromDocumentId, toDocumentId, maxDepth });
    
    // Using BFS implementation for stub
    const visited = new Set<string>();
    const queue: { docId: string; path: Document[]; sels: Selection[] }[] = [];
    const fromDoc = await this.getDocument(fromDocumentId);
    
    if (!fromDoc) return [];
    
    queue.push({ docId: fromDocumentId, path: [fromDoc], sels: [] });
    visited.add(fromDocumentId);
    
    const paths: GraphPath[] = [];
    
    while (queue.length > 0 && paths.length < 10) {
      const { docId, path, sels } = queue.shift()!;
      
      if (path.length > maxDepth) continue;
      
      if (docId === toDocumentId) {
        paths.push({ documents: path, selections: sels });
        continue;
      }
      
      const connections = await this.getDocumentConnections(docId);
      
      for (const conn of connections) {
        if (!visited.has(conn.targetDocument.id)) {
          visited.add(conn.targetDocument.id);
          queue.push({
            docId: conn.targetDocument.id,
            path: [...path, conn.targetDocument],
            sels: [...sels, ...conn.selections],
          });
        }
      }
    }
    
    return paths;
  }
  
  async getEntityTypeStats(): Promise<EntityTypeStats[]> {
    // In production: Use JanusGraph's analytics capabilities
    // const results = await this.client.submit(`
    //   g.V().hasLabel('Document')
    //     .values('entityTypes').unfold()
    //     .groupCount()
    // `);
    
    const typeCounts = new Map<string, number>();
    
    for (const doc of this.documents.values()) {
      for (const type of doc.entityTypes) {
        typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
      }
    }
    
    return Array.from(typeCounts.entries()).map(([type, count]) => ({
      type,
      count,
    }));
  }
  
  async getStats(): Promise<{
    documentCount: number;
    selectionCount: number;
    highlightCount: number;
    referenceCount: number;
    entityReferenceCount: number;
    entityTypes: Record<string, number>;
    contentTypes: Record<string, number>;
  }> {
    const entityTypes: Record<string, number> = {};
    const contentTypes: Record<string, number> = {};
    
    for (const doc of this.documents.values()) {
      for (const type of doc.entityTypes) {
        entityTypes[type] = (entityTypes[type] || 0) + 1;
      }
      contentTypes[doc.contentType] = (contentTypes[doc.contentType] || 0) + 1;
    }
    
    const selections = Array.from(this.selections.values());
    const highlightCount = selections.filter(isHighlight).length;
    const referenceCount = selections.filter(isReference).length;
    const entityReferenceCount = selections.filter(isEntityReference).length;
    
    return {
      documentCount: this.documents.size,
      selectionCount: this.selections.size,
      highlightCount,
      referenceCount,
      entityReferenceCount,
      entityTypes,
      contentTypes,
    };
  }
  
  async createSelections(inputs: CreateSelectionInput[]): Promise<Selection[]> {
    // In production: Use batch operations for better performance
    // const tx = graph.tx()
    // tx.rollback()
    // ... batch operations ...
    // tx.commit()
    
    const results: Selection[] = [];
    for (const input of inputs) {
      results.push(await this.createSelection(input));
    }
    return results;
  }
  
  async saveSelections(inputs: SaveSelectionInput[]): Promise<Selection[]> {
    const results: Selection[] = [];
    for (const input of inputs) {
      results.push(await this.saveSelection(input));
    }
    return results;
  }
  
  async resolveSelections(inputs: ResolveSelectionInput[]): Promise<Selection[]> {
    const results: Selection[] = [];
    for (const input of inputs) {
      results.push(await this.resolveSelection(input));
    }
    return results;
  }
  
  async detectSelections(_documentId: string): Promise<Selection[]> {
    // This would use AI/ML to detect selections in a document
    // For now, return empty array as a placeholder
    return [];
  }
  
  // Tag Collections - stored as special vertices in the graph
  private entityTypesCollection: Set<string> | null = null;
  private referenceTypesCollection: Set<string> | null = null;
  
  async getEntityTypes(): Promise<string[]> {
    // Initialize if not already loaded
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    return Array.from(this.entityTypesCollection!).sort();
  }
  
  async getReferenceTypes(): Promise<string[]> {
    // Initialize if not already loaded
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
    // In production: persist to JanusGraph
    // await this.client.submit(`g.V().has('tagCollection', 'type', 'entity-types')
    //   .property(set, 'tags', '${tag}')`, {});
  }
  
  async addReferenceType(tag: string): Promise<void> {
    if (this.referenceTypesCollection === null) {
      await this.initializeTagCollections();
    }
    this.referenceTypesCollection!.add(tag);
    // In production: persist to JanusGraph
    // await this.client.submit(`g.V().has('tagCollection', 'type', 'reference-types')
    //   .property(set, 'tags', '${tag}')`, {});
  }
  
  async addEntityTypes(tags: string[]): Promise<void> {
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    tags.forEach(tag => this.entityTypesCollection!.add(tag));
    // In production: persist to JanusGraph
  }
  
  async addReferenceTypes(tags: string[]): Promise<void> {
    if (this.referenceTypesCollection === null) {
      await this.initializeTagCollections();
    }
    tags.forEach(tag => this.referenceTypesCollection!.add(tag));
    // In production: persist to JanusGraph
  }
  
  private async initializeTagCollections(): Promise<void> {
    // In production: check JanusGraph for existing collections
    // const result = await this.client.submit(
    //   `g.V().has('tagCollection', 'type', within('entity-types', 'reference-types'))
    //    .project('type', 'tags').by('type').by('tags')`, {}
    // );
    
    // For now, initialize with defaults if not present
    if (this.entityTypesCollection === null) {
      const { DEFAULT_ENTITY_TYPES } = await import('../tag-collections');
      this.entityTypesCollection = new Set(DEFAULT_ENTITY_TYPES);
    }
    
    if (this.referenceTypesCollection === null) {
      const { DEFAULT_REFERENCE_TYPES } = await import('../tag-collections');
      this.referenceTypesCollection = new Set(DEFAULT_REFERENCE_TYPES);
    }
  }
  
  generateId(prefix: string = 'doc'): string {
    return `${prefix}_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  }
  
  async clearDatabase(): Promise<void> {
    // In production: CAREFUL! This would clear the entire graph
    // await this.client.submit(`g.V().drop()`);
    this.documents.clear();
    this.selections.clear();
    this.entityTypesCollection = null;
    this.referenceTypesCollection = null;
  }
}