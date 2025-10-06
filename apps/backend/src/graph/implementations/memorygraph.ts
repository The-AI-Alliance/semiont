// In-memory implementation of GraphDatabase interface
// Used for development and testing without requiring a real graph database

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

// Simple in-memory storage using Maps
// Useful for development and testing

export class MemoryGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  
  // In-memory storage using Maps
  private documents: Map<string, Document> = new Map();
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
  
  async createDocument(input: CreateDocumentInput): Promise<Document> {
    const id = this.generateId();
    const now = new Date();
    
    const document: Document = {
      id,
      name: input.name,
      entityTypes: input.entityTypes,
      contentType: input.contentType,
      metadata: input.metadata,
      archived: false,  // New documents are not archived by default
      creationMethod: input.creationMethod,
      contentChecksum: input.contentChecksum,
      createdAt: now,
      createdBy: input.createdBy,
    };

    // Provenance tracking fields
    if (input.sourceAnnotationId) document.sourceAnnotationId = input.sourceAnnotationId;
    if (input.sourceDocumentId) document.sourceDocumentId = input.sourceDocumentId;
    
    // Simply add to in-memory map
    // await this.client.submit(`
    //   graph.tx().rollback()
    //   g.addV('Document')
    //     .property('id', id)
    //     .property('name', name)
    //     .property('entityTypes', entityTypes)
    //     .property('contentType', contentType)
    //     .property('createdAt', createdAt)
    //     .property('updatedAt', updatedAt)
    //   graph.tx().commit()
    // `, { id, name, entityTypes, ... });
    
    this.documents.set(id, document);
    return document;
  }
  
  async getDocument(id: string): Promise<Document | null> {
    // Simply retrieve from map
    // const result = await this.client.submit(`
    //   g.V().hasLabel('Document').has('id', id).valueMap(true)
    // `, { id });
    
    return this.documents.get(id) || null;
  }
  
  async updateDocument(id: string, input: UpdateDocumentInput): Promise<Document> {
    // Documents are immutable - only archiving is allowed
    if (Object.keys(input).length !== 1 || input.archived === undefined) {
      throw new Error('Documents are immutable. Only archiving is allowed.');
    }

    const doc = this.documents.get(id);
    if (!doc) throw new Error('Document not found');

    doc.archived = input.archived;
    return doc;
  }
  
  async deleteDocument(id: string): Promise<void> {
    // Simply delete from map
    // await this.client.submit(`
    //   graph.tx().rollback()
    //   g.V().has('id', id).drop()
    //   graph.tx().commit()
    // `, { id });
    
    this.documents.delete(id);
    
    // Delete annotations
    for (const [selId, sel] of this.annotations) {
      if (sel.documentId === id || sel.referencedDocumentId === id) {
        this.annotations.delete(selId);
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
    // Simple text search in memory
    // const results = await this.client.submit(`
    //   g.V().has('Document', 'name', textContains(query)).limit(limit).valueMap(true)
    // `, { query, limit });
    
    const searchLower = query.toLowerCase();
    const results = Array.from(this.documents.values())
      .filter(doc => doc.name.toLowerCase().includes(searchLower))
      .slice(0, limit);
    
    return results;
  }
  
  async createAnnotation(input: CreateAnnotationInternal): Promise<Annotation> {
    const id = this.generateId();

    const annotation: Annotation = {
      id,
      documentId: input.documentId,
      text: input.text,
      selectionData: input.selectionData,
      type: input.type,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      entityTypes: input.entityTypes || [],
      referencedDocumentId: input.referencedDocumentId,
      referenceType: input.referenceType,
    };

    this.annotations.set(id, annotation);
    console.log('Memory: Created annotation:', {
      id,
      type: annotation.type,
      hasReferencedDocumentId: !!annotation.referencedDocumentId,
      entityTypes: annotation.entityTypes,
      referenceType: annotation.referenceType
    });
    return annotation;
  }
  
  async getAnnotation(id: string): Promise<Annotation | null> {
    return this.annotations.get(id) || null;
  }
  
  async updateAnnotation(id: string, updates: Partial<Annotation>): Promise<Annotation> {
    const annotation = this.annotations.get(id);
    if (!annotation) throw new Error('Annotation not found');

    const updated: Annotation = {
      ...annotation,
      ...updates,
    };

    this.annotations.set(id, updated);
    return updated;
  }
  
  async deleteAnnotation(id: string): Promise<void> {
    this.annotations.delete(id);
  }
  
  async listAnnotations(filter: { documentId?: string; type?: "highlight" | "reference" }): Promise<{ annotations: Annotation[]; total: number }> {
    let results = Array.from(this.annotations.values());

    if (filter.documentId) {
      results = results.filter(a => a.documentId === filter.documentId);
    }

    if (filter.type) {
      results = results.filter(a => a.type === filter.type);
    }

    return { annotations: results, total: results.length };
  }
  
  
  async getHighlights(documentId: string): Promise<Annotation[]> {
    const highlights = Array.from(this.annotations.values())
      .filter(sel => sel.documentId === documentId && !('referencedDocumentId' in sel));
    console.log(`Memory: getHighlights for ${documentId} found ${highlights.length} highlights`);
    return highlights;
  }
  
  async resolveReference(annotationId: string, referencedDocumentId: string): Promise<Annotation> {
    const annotation = this.annotations.get(annotationId);
    if (!annotation) throw new Error('Annotation not found');

    const updated: Annotation = {
      ...annotation,
      referencedDocumentId,
    };

    this.annotations.set(annotationId, updated);
    return updated;
  }
  
  async getReferences(documentId: string): Promise<Annotation[]> {
    const references = Array.from(this.annotations.values())
      .filter(sel => sel.documentId === documentId && 'referencedDocumentId' in sel);
    console.log(`Memory: getReferences for ${documentId} found ${references.length} references`);
    references.forEach(ref => {
      console.log('  Reference:', { 
        id: ref.id, 
        referencedDocumentId: ref.referencedDocumentId,
        entityTypes: ref.entityTypes,
        referenceType: ref.referenceType
      });
    });
    return references;
  }
  
  async getEntityReferences(documentId: string, entityTypes?: string[]): Promise<Annotation[]> {
    let refs = Array.from(this.annotations.values())
      .filter(sel => sel.documentId === documentId && sel.type === "reference" && sel.entityTypes.length > 0);
    
    if (entityTypes && entityTypes.length > 0) {
      refs = refs.filter(sel => 
        sel.entityTypes && sel.entityTypes.some(type => entityTypes.includes(type))
      );
    }
    
    return refs;
  }
  
  async getDocumentAnnotations(documentId: string): Promise<Annotation[]> {
    return Array.from(this.annotations.values())
      .filter(sel => sel.documentId === documentId);
  }
  
  async getDocumentReferencedBy(documentId: string): Promise<Annotation[]> {
    return Array.from(this.annotations.values())
      .filter(sel => sel.referencedDocumentId === documentId);
  }
  
  async getDocumentConnections(documentId: string): Promise<GraphConnection[]> {
    // Simple in-memory traversal
    // const results = await this.client.submit(`
    //   g.V().has('id', documentId)
    //     .bothE('REFERENCES').as('e')
    //     .otherV().as('v')
    //     .select('e', 'v')
    // `, { documentId });
    
    const connections: GraphConnection[] = [];
    const refs = await this.getReferences(documentId);
    
    for (const ref of refs) {
      if (ref.referencedDocumentId) {
        const targetDoc = await this.getDocument(ref.referencedDocumentId);
        if (targetDoc) {
          const reverseRefs = await this.getReferences(ref.referencedDocumentId);
          const bidirectional = reverseRefs.some(r => r.referencedDocumentId === documentId);
          
          connections.push({
            targetDocument: targetDoc,
            annotations: [ref],
            bidirectional,
          });
        }
      }
    }
    
    return connections;
  }
  
  async findPath(fromDocumentId: string, toDocumentId: string, maxDepth: number = 5): Promise<GraphPath[]> {
    // Path finding not implemented in memory version
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
    const queue: { docId: string; path: Document[]; sels: Annotation[] }[] = [];
    const fromDoc = await this.getDocument(fromDocumentId);
    
    if (!fromDoc) return [];
    
    queue.push({ docId: fromDocumentId, path: [fromDoc], sels: [] });
    visited.add(fromDocumentId);
    
    const paths: GraphPath[] = [];
    
    while (queue.length > 0 && paths.length < 10) {
      const { docId, path, sels } = queue.shift()!;
      
      if (path.length > maxDepth) continue;
      
      if (docId === toDocumentId) {
        paths.push({ documents: path, annotations: sels });
        continue;
      }
      
      const connections = await this.getDocumentConnections(docId);
      
      for (const conn of connections) {
        if (!visited.has(conn.targetDocument.id)) {
          visited.add(conn.targetDocument.id);
          queue.push({
            docId: conn.targetDocument.id,
            path: [...path, conn.targetDocument],
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
    annotationCount: number;
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
    
    const annotations = Array.from(this.annotations.values());
    const highlightCount = annotations.filter(a => a.type === 'highlight').length;
    const referenceCount = annotations.filter(a => a.type === 'reference').length;
    const entityReferenceCount = annotations.filter(a => a.type === 'reference' && a.entityTypes.length > 0).length;
    
    return {
      documentCount: this.documents.size,
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
  
  
  async resolveReferences(inputs: { annotationId: string; referencedDocumentId: string }[]): Promise<Annotation[]> {
    const results: Annotation[] = [];
    for (const input of inputs) {
      results.push(await this.resolveReference(input.annotationId, input.referencedDocumentId));
    }
    return results;
  }
  
  async detectAnnotations(_documentId: string): Promise<Annotation[]> {
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
    // Simply add to set
    // await this.client.submit(`g.V().has('tagCollection', 'type', 'entity-types')
    //   .property(set, 'tags', '${tag}')`, {});
  }
  
  async addReferenceType(tag: string): Promise<void> {
    if (this.referenceTypesCollection === null) {
      await this.initializeTagCollections();
    }
    this.referenceTypesCollection!.add(tag);
    // Simply add to set
    // await this.client.submit(`g.V().has('tagCollection', 'type', 'reference-types')
    //   .property(set, 'tags', '${tag}')`, {});
  }
  
  async addEntityTypes(tags: string[]): Promise<void> {
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    tags.forEach(tag => this.entityTypesCollection!.add(tag));
    // Simply add to set
  }
  
  async addReferenceTypes(tags: string[]): Promise<void> {
    if (this.referenceTypesCollection === null) {
      await this.initializeTagCollections();
    }
    tags.forEach(tag => this.referenceTypesCollection!.add(tag));
    // Simply add to set
  }
  
  private async initializeTagCollections(): Promise<void> {
    // Initialize in-memory collections
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
  
  generateId(): string {
    return uuidv4().replace(/-/g, '').substring(0, 12);
  }
  
  async clearDatabase(): Promise<void> {
    // In production: CAREFUL! This would clear the entire graph
    // await this.client.submit(`g.V().drop()`);
    this.documents.clear();
    this.annotations.clear();
    this.entityTypesCollection = null;
    this.referenceTypesCollection = null;
  }
}