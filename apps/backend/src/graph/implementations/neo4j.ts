// Neo4j implementation of GraphDatabase interface
// Uses Cypher query language

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

// Note: In production, you would use neo4j-driver
// For now, this is a stub that shows how Neo4j would be integrated

export class Neo4jGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  // private driver: any; // Would be neo4j.Driver in production
  
  // In-memory storage for development/testing (same as Neptune for now)
  private documents: Map<string, Document> = new Map();
  private selections: Map<string, Selection> = new Map();
  
  constructor(config: {
    uri?: string;
    username?: string;
    password?: string;
  } = {}) {
    // Config will be used when implementing actual Neo4j connection
    void config;
  }
  
  async connect(): Promise<void> {
    // In production: connect to Neo4j database using neo4j-driver
    // const neo4j = require('neo4j-driver');
    // this.driver = neo4j.driver(
    //   this.config.uri || 'bolt://localhost:7687',
    //   neo4j.auth.basic(this.config.username || 'neo4j', this.config.password || 'password')
    // );
    // 
    // // Test connection
    // const session = this.driver.session();
    // await session.run('RETURN 1');
    // await session.close();
    
    console.log('Connecting to Neo4j (simulated)...');
    this.connected = true;
  }
  
  async disconnect(): Promise<void> {
    // In production: close Neo4j driver
    // if (this.driver) await this.driver.close();
    this.connected = false;
  }
  
  isConnected(): boolean {
    return this.connected;
  }
  
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
      createdAt: now,
      updatedAt: now,
    };
    
    if (input.createdBy) document.createdBy = input.createdBy;
    if (input.createdBy) document.updatedBy = input.createdBy;
    
    // In production: Use Cypher to create node
    // const session = this.driver.session();
    // await session.run(
    //   `CREATE (d:Document {
    //     id: $id,
    //     name: $name,
    //     entityTypes: $entityTypes,
    //     contentType: $contentType,
    //     storageUrl: $storageUrl,
    //     createdAt: datetime($createdAt),
    //     updatedAt: datetime($updatedAt)
    //   }) RETURN d`,
    //   { id, name: document.name, entityTypes: document.entityTypes, ... }
    // );
    // await session.close();
    
    this.documents.set(id, document);
    return document;
  }
  
  async getDocument(id: string): Promise<Document | null> {
    // In production: Use Cypher to query node
    // const session = this.driver.session();
    // const result = await session.run(
    //   'MATCH (d:Document {id: $id}) RETURN d',
    //   { id }
    // );
    // await session.close();
    // 
    // if (result.records.length === 0) return null;
    // return result.records[0].get('d').properties;
    
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
      ...(input.updatedBy && { updatedBy: input.updatedBy }),
      updatedAt: new Date(),
    };
    
    // In production: Use Cypher SET clause
    // const session = this.driver.session();
    // await session.run(
    //   `MATCH (d:Document {id: $id})
    //    SET d.name = $name, d.entityTypes = $entityTypes, d.updatedAt = datetime()
    //    RETURN d`,
    //   { id, name: updated.name, entityTypes: updated.entityTypes }
    // );
    // await session.close();
    
    this.documents.set(id, updated);
    return updated;
  }
  
  async deleteDocument(id: string): Promise<void> {
    // In production: Use Cypher to delete node and relationships
    // const session = this.driver.session();
    // await session.run(
    //   'MATCH (d:Document {id: $id}) DETACH DELETE d',
    //   { id }
    // );
    // await session.close();
    
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
    // In production: Use Neo4j full-text search
    // const session = this.driver.session();
    // const result = await session.run(
    //   `CALL db.index.fulltext.queryNodes('document_search', $query)
    //    YIELD node, score
    //    RETURN node LIMIT $limit`,
    //   { query, limit }
    // );
    // await session.close();
    
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
    
    // In production: Create relationship in graph
    // const session = this.driver.session();
    // if (input.resolvedDocumentId) {
    //   await session.run(
    //     `MATCH (from:Document {id: $fromId})
    //      MATCH (to:Document {id: $toId})
    //      CREATE (from)-[r:REFERENCES {
    //        id: $id,
    //        selectionType: $selectionType,
    //        saved: $saved,
    //        provisional: $provisional,
    //        confidence: $confidence,
    //        createdAt: datetime()
    //      }]->(to)
    //      RETURN r`,
    //     { fromId: input.documentId, toId: input.resolvedDocumentId, ... }
    //   );
    // }
    // await session.close();
    
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
      .filter(sel => sel.documentId === documentId && sel.saved);
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
    // In production: Use Cypher with path patterns
    // const session = this.driver.session();
    // const result = await session.run(
    //   `MATCH (d:Document {id: $id})-[r:REFERENCES]-(other:Document)
    //    RETURN other, collect(r) as relationships`,
    //   { id: documentId }
    // );
    // await session.close();
    
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
    // In production: Use Cypher shortest path
    // const session = this.driver.session();
    // const result = await session.run(
    //   `MATCH p = shortestPath((from:Document {id: $fromId})-[*..${maxDepth}]-(to:Document {id: $toId}))
    //    RETURN p`,
    //   { fromId: fromDocumentId, toId: toDocumentId }
    // );
    // await session.close();
    
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
    // In production: Use Cypher aggregation
    // const session = this.driver.session();
    // const result = await session.run(
    //   `MATCH (d:Document)
    //    UNWIND d.entityTypes AS type
    //    RETURN type, count(*) AS count
    //    ORDER BY count DESC`
    // );
    // await session.close();
    
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
    // In production: Use batch operations
    // const session = this.driver.session();
    // const tx = session.beginTransaction();
    // ... batch operations ...
    // await tx.commit();
    // await session.close();
    
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
  
  generateId(prefix: string = 'doc'): string {
    return `${prefix}_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  }
  
  async clearDatabase(): Promise<void> {
    // In production: CAREFUL! This would clear the entire database
    // const session = this.driver.session();
    // await session.run('MATCH (n) DETACH DELETE n');
    // await session.close();
    this.documents.clear();
    this.selections.clear();
  }
}