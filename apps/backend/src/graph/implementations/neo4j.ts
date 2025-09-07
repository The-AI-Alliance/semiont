// Neo4j implementation of GraphDatabase interface
// Uses Cypher query language

import { GraphDatabase } from '../interface';
import {
  Document,
  Reference,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  DocumentFilter,
  ReferenceFilter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateReferenceInput,
  ResolveReferenceInput,
} from '../types';
import { v4 as uuidv4 } from 'uuid';

// Note: In production, you would use neo4j-driver
// For now, this is a stub that shows how Neo4j would be integrated

export class Neo4jGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  // private driver: any; // Would be neo4j.Driver in production
  
  // In-memory storage for development/testing (same as Neptune for now)
  private documents: Map<string, Document> = new Map();
  private references: Map<string, Reference> = new Map();
  
  constructor(config: {
    uri?: string;
    username?: string;
    password?: string;
  } = {}) {
    // Config will be used when implementing actual Neo4j connection
    void config;
  }
  
  async connect(): Promise<void> {
    // In production:
    // const neo4j = require('neo4j-driver');
    // this.driver = neo4j.driver(
    //   this.config.uri || 'bolt://localhost:7687',
    //   neo4j.auth.basic(this.config.username || 'neo4j', this.config.password || 'password')
    // );
    
    console.log('Connecting to Neo4j (simulated)...');
    this.connected = true;
  }
  
  async disconnect(): Promise<void> {
    // In production: await this.driver.close();
    this.connected = false;
  }
  
  isConnected(): boolean {
    return this.connected;
  }
  
  async createDocument(input: CreateDocumentInput): Promise<Document> {
    // In production, would use Cypher:
    // CREATE (d:Document {
    //   id: $id,
    //   name: $name,
    //   entityTypes: $entityTypes,
    //   ...
    // })
    // RETURN d
    
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
    
    this.documents.set(id, document);
    return document;
  }
  
  async getDocument(id: string): Promise<Document | null> {
    // In production: MATCH (d:Document {id: $id}) RETURN d
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
    
    this.documents.set(id, updated);
    return updated;
  }
  
  async deleteDocument(id: string): Promise<void> {
    // In production: MATCH (d:Document {id: $id}) DETACH DELETE d
    this.documents.delete(id);
    
    for (const [refId, ref] of this.references) {
      if (ref.documentId === id || ref.resolvedDocumentId === id) {
        this.references.delete(refId);
      }
    }
  }
  
  async listDocuments(filter: DocumentFilter): Promise<{ documents: Document[]; total: number }> {
    // In production: Use Cypher with WHERE clauses
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
    // In production: Use Neo4j full-text search indexes
    const searchLower = query.toLowerCase();
    const results = Array.from(this.documents.values())
      .filter(doc => doc.name.toLowerCase().includes(searchLower))
      .slice(0, limit);
    
    return results;
  }
  
  async createReference(input: CreateReferenceInput): Promise<Reference> {
    // In production: Create relationship in Neo4j
    // MATCH (from:Document {id: $fromId}), (to:Document {id: $toId})
    // CREATE (from)-[r:REFERENCES {properties}]->(to)
    
    const id = this.generateId();
    const now = new Date();
    
    const reference: Reference = {
      id,
      documentId: input.documentId,
      referenceType: input.referenceType,
      referenceData: input.referenceData,
      provisional: input.provisional || false,
      createdAt: now,
      updatedAt: now,
    };
    
    if (input.resolvedDocumentId) reference.resolvedDocumentId = input.resolvedDocumentId;
    if (input.confidence !== undefined) reference.confidence = input.confidence;
    if (input.metadata) reference.metadata = input.metadata;
    if (input.resolvedBy) reference.resolvedBy = input.resolvedBy;
    if (input.resolvedDocumentId) reference.resolvedAt = now;
    
    this.references.set(id, reference);
    return reference;
  }
  
  async getReference(id: string): Promise<Reference | null> {
    return this.references.get(id) || null;
  }
  
  async resolveReference(input: ResolveReferenceInput): Promise<Reference> {
    const ref = this.references.get(input.referenceId);
    if (!ref) throw new Error('Reference not found');
    
    const updated: Reference = {
      ...ref,
      resolvedDocumentId: input.documentId,
      provisional: input.provisional || false,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    };
    
    if (input.confidence !== undefined) updated.confidence = input.confidence;
    if (input.resolvedBy) updated.resolvedBy = input.resolvedBy;
    if (input.metadata || ref.metadata) {
      updated.metadata = { ...ref.metadata, ...input.metadata };
    }
    
    this.references.set(input.referenceId, updated);
    return updated;
  }
  
  async deleteReference(id: string): Promise<void> {
    this.references.delete(id);
  }
  
  async listReferences(filter: ReferenceFilter): Promise<{ references: Reference[]; total: number }> {
    let refs = Array.from(this.references.values());
    
    if (filter.documentId) {
      refs = refs.filter(ref => ref.documentId === filter.documentId);
    }
    
    if (filter.resolvedDocumentId) {
      refs = refs.filter(ref => ref.resolvedDocumentId === filter.resolvedDocumentId);
    }
    
    if (filter.provisional !== undefined) {
      refs = refs.filter(ref => ref.provisional === filter.provisional);
    }
    
    const total = refs.length;
    const offset = filter.offset || 0;
    const limit = filter.limit || 20;
    refs = refs.slice(offset, offset + limit);
    
    return { references: refs, total };
  }
  
  async getDocumentReferences(documentId: string): Promise<Reference[]> {
    return Array.from(this.references.values())
      .filter(ref => ref.documentId === documentId);
  }
  
  async getDocumentReferencedBy(documentId: string): Promise<Reference[]> {
    return Array.from(this.references.values())
      .filter(ref => ref.resolvedDocumentId === documentId);
  }
  
  async getDocumentConnections(documentId: string): Promise<GraphConnection[]> {
    // In production: Use Cypher pattern matching
    // MATCH (d:Document {id: $id})-[r:REFERENCES]-(connected:Document)
    // RETURN connected, collect(r) as references
    
    const connections: GraphConnection[] = [];
    const refs = await this.getDocumentReferences(documentId);
    
    for (const ref of refs) {
      if (ref.resolvedDocumentId) {
        const targetDoc = await this.getDocument(ref.resolvedDocumentId);
        if (targetDoc) {
          const reverseRefs = await this.getDocumentReferences(ref.resolvedDocumentId);
          const bidirectional = reverseRefs.some(r => r.resolvedDocumentId === documentId);
          
          connections.push({
            targetDocument: targetDoc,
            references: [ref],
            bidirectional,
          });
        }
      }
    }
    
    return connections;
  }
  
  async findPath(fromDocumentId: string, toDocumentId: string, maxDepth: number = 5): Promise<GraphPath[]> {
    // In production: Use Cypher shortest path
    // MATCH path = shortestPath(
    //   (from:Document {id: $fromId})-[*..5]-(to:Document {id: $toId})
    // )
    // RETURN path
    
    // Using same BFS implementation as Neptune for now
    const visited = new Set<string>();
    const queue: { docId: string; path: Document[]; refs: Reference[] }[] = [];
    const fromDoc = await this.getDocument(fromDocumentId);
    
    if (!fromDoc) return [];
    
    queue.push({ docId: fromDocumentId, path: [fromDoc], refs: [] });
    visited.add(fromDocumentId);
    
    const paths: GraphPath[] = [];
    
    while (queue.length > 0 && paths.length < 10) {
      const { docId, path, refs } = queue.shift()!;
      
      if (path.length > maxDepth) continue;
      
      if (docId === toDocumentId) {
        paths.push({ documents: path, references: refs });
        continue;
      }
      
      const connections = await this.getDocumentConnections(docId);
      
      for (const conn of connections) {
        if (!visited.has(conn.targetDocument.id)) {
          visited.add(conn.targetDocument.id);
          queue.push({
            docId: conn.targetDocument.id,
            path: [...path, conn.targetDocument],
            refs: [...refs, ...conn.references],
          });
        }
      }
    }
    
    return paths;
  }
  
  async getEntityTypeStats(): Promise<EntityTypeStats[]> {
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
    referenceCount: number;
    resolvedReferenceCount: number;
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
    
    const resolvedCount = Array.from(this.references.values())
      .filter(ref => ref.resolvedDocumentId && !ref.provisional).length;
    
    return {
      documentCount: this.documents.size,
      referenceCount: this.references.size,
      resolvedReferenceCount: resolvedCount,
      entityTypes,
      contentTypes,
    };
  }
  
  async createReferences(inputs: CreateReferenceInput[]): Promise<Reference[]> {
    const results: Reference[] = [];
    for (const input of inputs) {
      results.push(await this.createReference(input));
    }
    return results;
  }
  
  async resolveReferences(inputs: ResolveReferenceInput[]): Promise<Reference[]> {
    const results: Reference[] = [];
    for (const input of inputs) {
      results.push(await this.resolveReference(input));
    }
    return results;
  }
  
  generateId(): string {
    return `doc_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  }
  
  async clearDatabase(): Promise<void> {
    this.documents.clear();
    this.references.clear();
  }
}