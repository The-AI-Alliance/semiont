// AWS Neptune implementation of GraphDatabase interface
// Uses Gremlin for graph traversal

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

// Dynamic imports for AWS SDK and Gremlin
let NeptuneClient: any;
let DescribeDBClustersCommand: any;
let gremlin: any;

async function loadDependencies() {
  if (!NeptuneClient) {
    const neptuneModule = await import('@aws-sdk/client-neptune');
    NeptuneClient = neptuneModule.NeptuneClient;
    DescribeDBClustersCommand = neptuneModule.DescribeDBClustersCommand;
  }
  if (!gremlin) {
    gremlin = await import('gremlin');
  }
}

export class NeptuneGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  private neptuneEndpoint?: string;
  private neptunePort: number = 8182;
  private region?: string;
  private client: any; // Gremlin client
  private g: any; // Gremlin graph traversal source
  
  // In-memory storage for development/testing (will be replaced with Neptune queries)
  private documents: Map<string, Document> = new Map();
  private selections: Map<string, Selection> = new Map();
  
  constructor(config: {
    endpoint?: string;
    port?: number;
    region?: string;
  } = {}) {
    this.neptuneEndpoint = config.endpoint;
    this.neptunePort = config.port || 8182;
    this.region = config.region || process.env.AWS_REGION;
  }
  
  private async discoverNeptuneEndpoint(): Promise<void> {
    // If endpoint is already provided, use it
    if (this.neptuneEndpoint) {
      return;
    }
    
    // In AWS environment, discover Neptune cluster endpoint
    if (!this.region) {
      throw new Error('AWS_REGION must be set for Neptune endpoint discovery');
    }

    try {
      // Load AWS SDK dynamically
      await loadDependencies();
      
      // Create Neptune client
      const client = new NeptuneClient({ region: this.region });
      
      // List all Neptune clusters
      const command = new DescribeDBClustersCommand({});
      const response = await client.send(command);
      
      if (!response.DBClusters || response.DBClusters.length === 0) {
        throw new Error('No Neptune clusters found in region ' + this.region);
      }
      
      // Find the Semiont cluster by tags
      let cluster = null;
      for (const dbCluster of response.DBClusters) {
        // Check if this cluster has our application tag
        const tagsCommand = new DescribeDBClustersCommand({
          DBClusterIdentifier: dbCluster.DBClusterIdentifier
        });
        const clusterDetails = await client.send(tagsCommand);
        
        if (clusterDetails.DBClusters && clusterDetails.DBClusters[0]) {
          const clusterInfo = clusterDetails.DBClusters[0];
          // Check for Semiont tag or name pattern
          if (clusterInfo.DBClusterIdentifier?.includes('Semiont') || 
              clusterInfo.DBClusterIdentifier?.includes('semiont')) {
            cluster = clusterInfo;
            break;
          }
        }
      }
      
      if (!cluster) {
        throw new Error('No Semiont Neptune cluster found in region ' + this.region);
      }
      
      // Set the endpoint and port
      this.neptuneEndpoint = cluster.Endpoint;
      this.neptunePort = cluster.Port || 8182;
      
      console.log(`Discovered Neptune endpoint: ${this.neptuneEndpoint}:${this.neptunePort}`);
    } catch (error: any) {
      console.error('Failed to discover Neptune endpoint:', error);
      // If discovery fails but we're in development, continue with in-memory
      if (process.env.NODE_ENV === 'development') {
        console.warn('Neptune discovery failed in development, using in-memory graph database');
        this.neptuneEndpoint = 'memory';
      } else {
        throw error;
      }
    }
  }
  
  async connect(): Promise<void> {
    // Discover Neptune endpoint if needed
    await this.discoverNeptuneEndpoint();
    
    // If using in-memory fallback, skip Gremlin connection
    if (this.neptuneEndpoint === 'memory') {
      console.log('Using in-memory graph database');
      this.connected = true;
      return;
    }
    
    try {
      // Load Gremlin dynamically
      await loadDependencies();
      
      // Create Gremlin connection
      const traversal = gremlin.process.AnonymousTraversalSource.traversal;
      const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
      
      // Neptune requires WebSocket Secure (wss) protocol
      const connectionUrl = `wss://${this.neptuneEndpoint}:${this.neptunePort}/gremlin`;
      console.log(`Connecting to Neptune at ${connectionUrl}`);
      
      // Create the connection
      const connection = new DriverRemoteConnection(connectionUrl, {
        authenticator: null, // Neptune uses IAM authentication via task role
        rejectUnauthorized: true,
        traversalSource: 'g'
      });
      
      // Create the graph traversal source
      this.g = traversal().withRemote(connection);
      
      // Test the connection
      const count = await this.g.V().limit(1).count().next();
      console.log(`Connected to Neptune. Vertex count test: ${count.value}`);
      
      this.connected = true;
    } catch (error: any) {
      console.error('Failed to connect to Neptune:', error);
      // If connection fails but we're in development, continue with in-memory
      if (process.env.NODE_ENV === 'development') {
        console.warn('Neptune connection failed in development, using in-memory graph database');
        this.neptuneEndpoint = 'memory';
        this.connected = true;
      } else {
        throw error;
      }
    }
  }
  
  async disconnect(): Promise<void> {
    // Close Gremlin connection if it exists
    if (this.g && this.neptuneEndpoint !== 'memory') {
      try {
        const connection = this.g.getConnection();
        if (connection) {
          await connection.close();
        }
      } catch (error) {
        console.error('Error closing Neptune connection:', error);
      }
    }
    
    this.connected = false;
    console.log('Disconnected from Neptune');
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
    
    // If connected to Neptune, create vertex in graph
    if (this.g && this.neptuneEndpoint !== 'memory') {
      try {
        await this.g.addV('Document')
          .property('id', document.id)
          .property('name', document.name)
          .property('contentType', document.contentType)
          .property('storageUrl', document.storageUrl)
          .property('createdAt', document.createdAt.toISOString())
          .property('updatedAt', document.updatedAt.toISOString())
          .property('createdBy', document.createdBy || '')
          .property('updatedBy', document.updatedBy || '')
          .property('entityTypes', JSON.stringify(document.entityTypes))
          .property('metadata', JSON.stringify(document.metadata))
          .next();
        
        console.log(`Created document vertex in Neptune: ${document.id}`);
      } catch (error) {
        console.error('Failed to create document in Neptune:', error);
        // Fall back to in-memory storage
      }
    }
    
    // Also store in memory for now (hybrid approach during migration)
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
      ...(input.updatedBy && { updatedBy: input.updatedBy }),
      updatedAt: new Date(),
    };
    
    // In production: Use Gremlin to update properties
    // await this.client.submit(`
    //   g.V().has('id', id)
    //     .property('name', name)
    //     .property('entityTypes', entityTypes)
    //     .property('updatedAt', new Date())
    // `, { id, name, entityTypes, ... });
    
    this.documents.set(id, updated);
    return updated;
  }
  
  async deleteDocument(id: string): Promise<void> {
    // In production: Use Gremlin to delete vertex and edges
    // await this.client.submit(`
    //   g.V().has('id', id).drop()
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
    // In production: Use Neptune's full-text search capabilities
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
    const id = this.generateId();
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
    //   g.V().has('id', documentId).as('from')
    //     .V().has('id', resolvedDocumentId).as('to')
    //     .addE('REFERENCES').from('from').to('to')
    //     .property('id', id)
    //     .property('selectionType', selectionType)
    //     .property('saved', saved)
    //     .property('provisional', provisional)
    //     .property('confidence', confidence)
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
    // In production: Use Gremlin traversal with Neptune optimizations
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
    // In production: Use Neptune's optimized path queries
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
    // In production: Use Neptune's analytics capabilities
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
  
  generateId(): string {
    return `doc_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  }
  
  async clearDatabase(): Promise<void> {
    // In production: CAREFUL! This would clear the entire graph
    // await this.client.submit(`g.V().drop()`);
    this.documents.clear();
    this.selections.clear();
  }
}