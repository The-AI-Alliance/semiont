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
} from '../types';
import { v4 as uuidv4 } from 'uuid';

// Dynamic imports for AWS SDK and Gremlin
let NeptuneClient: any;
let DescribeDBClustersCommand: any;
let gremlin: any;
let process: any;
let TextP: any;
let order: any;
let cardinality: any;
let __: any;

async function loadDependencies() {
  if (!NeptuneClient) {
    const neptuneModule = await import('@aws-sdk/client-neptune');
    NeptuneClient = neptuneModule.NeptuneClient;
    DescribeDBClustersCommand = neptuneModule.DescribeDBClustersCommand;
  }
  if (!gremlin) {
    // @ts-ignore - gremlin module has no types
    gremlin = await import('gremlin');
    process = gremlin.process;
    TextP = process.TextP;
    order = process.order;
    cardinality = process.cardinality;
    __ = process.statics;
  }
}

// Helper function to convert Neptune vertex to Document
function vertexToDocument(vertex: any): Document {
  const props = vertex.properties || vertex;
  
  // Handle different property formats from Neptune
  const getValue = (key: string) => {
    const prop = props[key];
    if (!prop) return undefined;
    if (Array.isArray(prop) && prop.length > 0) {
      return prop[0].value !== undefined ? prop[0].value : prop[0];
    }
    return prop.value !== undefined ? prop.value : prop;
  };
  
  const doc: Document = {
    id: getValue('id') || vertex.id,
    name: getValue('name') || '',
    entityTypes: JSON.parse(getValue('entityTypes') || '[]'),
    contentType: getValue('contentType') || 'text/plain',
    storageUrl: getValue('storageUrl') || '',
    metadata: JSON.parse(getValue('metadata') || '{}'),
    archived: getValue('archived') === 'true' || getValue('archived') === true || false,
    createdAt: new Date(getValue('createdAt') || Date.now()),
    updatedAt: new Date(getValue('updatedAt') || Date.now()),
  };
  
  const createdBy = getValue('createdBy');
  if (createdBy) doc.createdBy = createdBy;
  
  const updatedBy = getValue('updatedBy');
  if (updatedBy) doc.updatedBy = updatedBy;
  
  return doc;
}

// Helper function to convert Neptune edge to Selection
function edgeToSelection(edge: any): Selection {
  const props = edge.properties || edge;
  
  // Handle different property formats from Neptune
  const getValue = (key: string) => {
    const prop = props[key];
    if (!prop) return undefined;
    if (typeof prop === 'object' && 'value' in prop) return prop.value;
    return prop;
  };
  
  const selection: Selection = {
    id: getValue('id') || edge.id,
    documentId: getValue('documentId') || '',
    selectionType: getValue('selectionType') || 'highlight',
    selectionData: JSON.parse(getValue('selectionData') || '{}'),
    saved: getValue('saved') === 'true' || getValue('saved') === true,
    provisional: getValue('provisional') === 'true' || getValue('provisional') === true,
    createdAt: new Date(getValue('createdAt') || Date.now()),
    updatedAt: new Date(getValue('updatedAt') || Date.now()),
  };
  
  // Optional fields
  const resolvedDocumentId = getValue('resolvedDocumentId');
  if (resolvedDocumentId) selection.resolvedDocumentId = resolvedDocumentId;
  
  const resolvedAt = getValue('resolvedAt');
  if (resolvedAt) selection.resolvedAt = new Date(resolvedAt);
  
  const savedAt = getValue('savedAt');
  if (savedAt) selection.savedAt = new Date(savedAt);
  
  const savedBy = getValue('savedBy');
  if (savedBy) selection.savedBy = savedBy;
  
  const resolvedBy = getValue('resolvedBy');
  if (resolvedBy) selection.resolvedBy = resolvedBy;
  
  const referenceTags = getValue('referenceTags');
  if (referenceTags) selection.referenceTags = JSON.parse(referenceTags);
  
  const entityTypes = getValue('entityTypes');
  if (entityTypes) selection.entityTypes = JSON.parse(entityTypes);
  
  const confidence = getValue('confidence');
  if (confidence !== undefined) selection.confidence = parseFloat(confidence);
  
  const metadata = getValue('metadata');
  if (metadata) selection.metadata = JSON.parse(metadata);
  
  return selection;
}

export class NeptuneGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  private neptuneEndpoint?: string;
  private neptunePort: number = 8182;
  private region?: string;
  private g: any; // Gremlin graph traversal source
  private connection: any; // Gremlin connection
  
  constructor(config: {
    endpoint?: string;
    port?: number;
    region?: string;
  } = {}) {
    if (config.endpoint) this.neptuneEndpoint = config.endpoint;
    this.neptunePort = config.port || 8182;
    if (config.region) this.region = config.region;
  }
  
  private async discoverNeptuneEndpoint(): Promise<void> {
    // If endpoint is already provided, use it
    if (this.neptuneEndpoint) {
      return;
    }
    
    // In AWS environment, discover Neptune cluster endpoint
    if (!this.region) {
      throw new Error('AWS region must be configured in environment JSON file (aws.region) for Neptune endpoint discovery');
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
      throw error;
    }
  }
  
  async connect(): Promise<void> {
    // Discover Neptune endpoint if needed
    await this.discoverNeptuneEndpoint();
    
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
      this.connection = new DriverRemoteConnection(connectionUrl, {
        authenticator: null, // Neptune uses IAM authentication via task role
        rejectUnauthorized: true,
        traversalSource: 'g'
      });
      
      // Create the graph traversal source
      this.g = traversal().withRemote(this.connection);
      
      // Test the connection
      const count = await this.g.V().limit(1).count().next();
      console.log(`Connected to Neptune. Vertex count test: ${count.value}`);
      
      this.connected = true;
    } catch (error: any) {
      console.error('Failed to connect to Neptune:', error);
      throw error;
    }
  }
  
  async disconnect(): Promise<void> {
    // Close Gremlin connection if it exists
    if (this.connection) {
      try {
        await this.connection.close();
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
      contentType: input.contentType || 'text/plain',
      storageUrl: `/efs/documents/${id}`,
      metadata: input.metadata || {},
      archived: false,
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
    
    // Create vertex in Neptune
    try {
      await this.g.addV('Document')
        .property('id', document.id)
        .property('name', document.name)
        .property('contentType', document.contentType)
        .property('storageUrl', document.storageUrl)
        .property('archived', document.archived)
        .property('createdAt', document.createdAt.toISOString())
        .property('updatedAt', document.updatedAt.toISOString())
        .property('createdBy', document.createdBy || '')
        .property('updatedBy', document.updatedBy || '')
        .property('entityTypes', JSON.stringify(document.entityTypes))
        .property('metadata', JSON.stringify(document.metadata))
        .next();
      
      console.log(`Created document vertex in Neptune: ${document.id}`);
      return document;
    } catch (error) {
      console.error('Failed to create document in Neptune:', error);
      throw error;
    }
  }
  
  async getDocument(id: string): Promise<Document | null> {
    try {
      const result = await this.g.V()
        .hasLabel('Document')
        .has('id', id)
        .elementMap()
        .next();
      
      if (!result.value) {
        return null;
      }
      
      return vertexToDocument(result.value);
    } catch (error) {
      console.error('Failed to get document from Neptune:', error);
      throw error;
    }
  }
  
  async updateDocument(id: string, input: UpdateDocumentInput): Promise<Document> {
    try {
      // Start with the vertex
      let traversal = this.g.V()
        .hasLabel('Document')
        .has('id', id);
      
      // Update properties
      if (input.name !== undefined) {
        traversal = traversal.property('name', input.name);
      }
      if (input.entityTypes !== undefined) {
        traversal = traversal.property('entityTypes', JSON.stringify(input.entityTypes));
      }
      if (input.metadata !== undefined) {
        traversal = traversal.property('metadata', JSON.stringify(input.metadata));
      }
      if (input.archived !== undefined) {
        traversal = traversal.property('archived', input.archived);
      }
      if (input.updatedBy !== undefined) {
        traversal = traversal.property('updatedBy', input.updatedBy);
      }
      
      // Always update the timestamp
      traversal = traversal.property('updatedAt', new Date().toISOString());
      
      // Execute the update and return the updated vertex
      const result = await traversal.elementMap().next();
      
      if (!result.value) {
        throw new Error('Document not found');
      }
      
      return vertexToDocument(result.value);
    } catch (error) {
      console.error('Failed to update document in Neptune:', error);
      throw error;
    }
  }
  
  async deleteDocument(id: string): Promise<void> {
    try {
      // Delete the document vertex and all connected edges
      await this.g.V()
        .hasLabel('Document')
        .has('id', id)
        .drop()
        .iterate();
      
      console.log(`Deleted document from Neptune: ${id}`);
    } catch (error) {
      console.error('Failed to delete document from Neptune:', error);
      throw error;
    }
  }
  
  async listDocuments(filter: DocumentFilter): Promise<{ documents: Document[]; total: number }> {
    try {
      let traversal = this.g.V().hasLabel('Document');
      
      // Apply filters
      if (filter.entityTypes && filter.entityTypes.length > 0) {
        // Filter by entity types (stored as JSON string)
        traversal = traversal.filter(
          process.statics.or(
            ...filter.entityTypes.map((type: string) =>
              process.statics.has('entityTypes', TextP.containing(`"${type}"`))
            )
          )
        );
      }
      
      if (filter.search) {
        // Case-insensitive search in document name
        traversal = traversal.has('name', TextP.containing(filter.search));
      }
      
      // Count total before pagination
      const totalResult = await traversal.clone().count().next();
      const total = totalResult.value || 0;
      
      // Apply pagination
      const offset = filter.offset || 0;
      const limit = filter.limit || 20;
      
      const results = await traversal
        .order().by('createdAt', order.desc)
        .range(offset, offset + limit)
        .elementMap()
        .toList();
      
      const documents = results.map(vertexToDocument);
      
      return { documents, total };
    } catch (error) {
      console.error('Failed to list documents from Neptune:', error);
      throw error;
    }
  }
  
  async searchDocuments(query: string, limit: number = 20): Promise<Document[]> {
    try {
      // Use Neptune's text search capabilities
      const results = await this.g.V()
        .hasLabel('Document')
        .has('name', TextP.containing(query))
        .order().by('createdAt', order.desc)
        .limit(limit)
        .elementMap()
        .toList();
      
      return results.map(vertexToDocument);
    } catch (error) {
      console.error('Failed to search documents in Neptune:', error);
      throw error;
    }
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
    
    try {
      // Create edge in graph
      let traversal = this.g.V()
        .hasLabel('Document')
        .has('id', input.documentId)
        .as('from');
      
      if (input.resolvedDocumentId) {
        // Create edge to resolved document
        traversal = traversal
          .V()
          .hasLabel('Document')
          .has('id', input.resolvedDocumentId)
          .addE('REFERENCES')
          .from('from');
      } else {
        // Create self-edge for highlights
        traversal = traversal
          .addE('HAS_SELECTION')
          .to('from');
      }
      
      // Add edge properties
      traversal = traversal
        .property('id', selection.id)
        .property('documentId', selection.documentId)
        .property('selectionType', selection.selectionType)
        .property('selectionData', JSON.stringify(selection.selectionData))
        .property('saved', selection.saved.toString())
        .property('provisional', selection.provisional.toString())
        .property('createdAt', selection.createdAt.toISOString())
        .property('updatedAt', selection.updatedAt.toISOString());
      
      // Add optional properties
      if (selection.resolvedDocumentId) {
        traversal = traversal.property('resolvedDocumentId', selection.resolvedDocumentId);
      }
      if (selection.resolvedAt) {
        traversal = traversal.property('resolvedAt', selection.resolvedAt.toISOString());
      }
      if (selection.savedAt) {
        traversal = traversal.property('savedAt', selection.savedAt.toISOString());
      }
      if (selection.savedBy) {
        traversal = traversal.property('savedBy', selection.savedBy);
      }
      if (selection.resolvedBy) {
        traversal = traversal.property('resolvedBy', selection.resolvedBy);
      }
      if (selection.referenceTags) {
        traversal = traversal.property('referenceTags', JSON.stringify(selection.referenceTags));
      }
      if (selection.entityTypes) {
        traversal = traversal.property('entityTypes', JSON.stringify(selection.entityTypes));
      }
      if (selection.confidence !== undefined) {
        traversal = traversal.property('confidence', selection.confidence.toString());
      }
      if (selection.metadata) {
        traversal = traversal.property('metadata', JSON.stringify(selection.metadata));
      }
      
      await traversal.next();
      
      console.log(`Created selection edge in Neptune: ${selection.id}`);
      return selection;
    } catch (error) {
      console.error('Failed to create selection in Neptune:', error);
      throw error;
    }
  }
  
  async getSelection(id: string): Promise<Selection | null> {
    try {
      const result = await this.g.E()
        .has('id', id)
        .elementMap()
        .next();
      
      if (!result.value) {
        return null;
      }
      
      return edgeToSelection(result.value);
    } catch (error) {
      console.error('Failed to get selection from Neptune:', error);
      throw error;
    }
  }
  
  async updateSelection(id: string, updates: Partial<Selection>): Promise<Selection> {
    try {
      let traversal = this.g.E().has('id', id);
      
      // Update properties
      if (updates.saved !== undefined) {
        traversal = traversal.property('saved', updates.saved.toString());
      }
      if (updates.provisional !== undefined) {
        traversal = traversal.property('provisional', updates.provisional.toString());
      }
      if (updates.resolvedDocumentId !== undefined) {
        traversal = traversal.property('resolvedDocumentId', updates.resolvedDocumentId);
      }
      if (updates.referenceTags !== undefined) {
        traversal = traversal.property('referenceTags', JSON.stringify(updates.referenceTags));
      }
      if (updates.entityTypes !== undefined) {
        traversal = traversal.property('entityTypes', JSON.stringify(updates.entityTypes));
      }
      if (updates.confidence !== undefined) {
        traversal = traversal.property('confidence', updates.confidence.toString());
      }
      if (updates.metadata !== undefined) {
        traversal = traversal.property('metadata', JSON.stringify(updates.metadata));
      }
      if (updates.savedBy !== undefined) {
        traversal = traversal.property('savedBy', updates.savedBy);
      }
      if (updates.savedAt !== undefined) {
        traversal = traversal.property('savedAt', updates.savedAt.toISOString());
      }
      if (updates.resolvedBy !== undefined) {
        traversal = traversal.property('resolvedBy', updates.resolvedBy);
      }
      if (updates.resolvedAt !== undefined) {
        traversal = traversal.property('resolvedAt', updates.resolvedAt.toISOString());
      }
      
      // Always update timestamp
      traversal = traversal.property('updatedAt', new Date().toISOString());
      
      const result = await traversal.elementMap().next();
      
      if (!result.value) {
        throw new Error('Selection not found');
      }
      
      return edgeToSelection(result.value);
    } catch (error) {
      console.error('Failed to update selection in Neptune:', error);
      throw error;
    }
  }
  
  async deleteSelection(id: string): Promise<void> {
    try {
      await this.g.E()
        .has('id', id)
        .drop()
        .iterate();
      
      console.log(`Deleted selection from Neptune: ${id}`);
    } catch (error) {
      console.error('Failed to delete selection from Neptune:', error);
      throw error;
    }
  }
  
  async listSelections(filter: SelectionFilter): Promise<{ selections: Selection[]; total: number }> {
    try {
      let traversal = this.g.E().hasLabel('REFERENCES', 'HAS_SELECTION');
      
      // Apply filters
      if (filter.documentId) {
        traversal = traversal.has('documentId', filter.documentId);
      }
      
      if (filter.resolvedDocumentId) {
        traversal = traversal.has('resolvedDocumentId', filter.resolvedDocumentId);
      }
      
      if (filter.provisional !== undefined) {
        traversal = traversal.has('provisional', filter.provisional.toString());
      }
      
      if (filter.saved !== undefined) {
        traversal = traversal.has('saved', filter.saved.toString());
      }
      
      if (filter.resolved !== undefined) {
        if (filter.resolved) {
          traversal = traversal.has('resolvedDocumentId');
        } else {
          traversal = traversal.hasNot('resolvedDocumentId');
        }
      }
      
      if (filter.hasEntityTypes !== undefined) {
        if (filter.hasEntityTypes) {
          traversal = traversal.has('entityTypes');
        } else {
          traversal = traversal.hasNot('entityTypes');
        }
      }
      
      if (filter.referenceTags && filter.referenceTags.length > 0) {
        traversal = traversal.filter(
          process.statics.or(
            ...filter.referenceTags.map((tag: string) =>
              process.statics.has('referenceTags', TextP.containing(`"${tag}"`))
            )
          )
        );
      }
      
      // Count total before pagination
      const totalResult = await traversal.clone().count().next();
      const total = totalResult.value || 0;
      
      // Apply pagination
      const offset = filter.offset || 0;
      const limit = filter.limit || 20;
      
      const results = await traversal
        .order().by('createdAt', order.desc)
        .range(offset, offset + limit)
        .elementMap()
        .toList();
      
      const selections = results.map(edgeToSelection);
      
      return { selections, total };
    } catch (error) {
      console.error('Failed to list selections from Neptune:', error);
      throw error;
    }
  }
  
  async saveSelection(input: SaveSelectionInput): Promise<Selection> {
    try {
      const now = new Date();
      
      let traversal = this.g.E()
        .has('id', input.selectionId)
        .property('saved', 'true')
        .property('savedAt', now.toISOString())
        .property('updatedAt', now.toISOString());
      
      if (input.savedBy) {
        traversal = traversal.property('savedBy', input.savedBy);
      }
      
      if (input.metadata) {
        // Merge metadata
        const existing = await this.g.E()
          .has('id', input.selectionId)
          .values('metadata')
          .next();
        
        const existingMetadata = existing.value ? JSON.parse(existing.value) : {};
        const mergedMetadata = { ...existingMetadata, ...input.metadata };
        traversal = traversal.property('metadata', JSON.stringify(mergedMetadata));
      }
      
      const result = await traversal.elementMap().next();
      
      if (!result.value) {
        throw new Error('Selection not found');
      }
      
      return edgeToSelection(result.value);
    } catch (error) {
      console.error('Failed to save selection in Neptune:', error);
      throw error;
    }
  }
  
  async getHighlights(documentId: string): Promise<Selection[]> {
    try {
      const results = await this.g.E()
        .hasLabel('HAS_SELECTION')
        .has('documentId', documentId)
        .has('saved', 'true')
        .elementMap()
        .toList();
      
      return results.map(edgeToSelection);
    } catch (error) {
      console.error('Failed to get highlights from Neptune:', error);
      throw error;
    }
  }
  
  async resolveSelection(input: ResolveSelectionInput): Promise<Selection> {
    try {
      const now = new Date();
      
      // Need to recreate the edge with proper connection
      // First get the existing edge data
      const existing = await this.g.E()
        .has('id', input.selectionId)
        .elementMap()
        .next();
      
      if (!existing.value) {
        throw new Error('Selection not found');
      }
      
      const existingSelection = edgeToSelection(existing.value);
      
      // Delete old edge
      await this.g.E().has('id', input.selectionId).drop().iterate();
      
      // Create new edge with resolved document
      let traversal = this.g.V()
        .hasLabel('Document')
        .has('id', existingSelection.documentId)
        .as('from')
        .V()
        .hasLabel('Document')
        .has('id', input.documentId)
        .addE('REFERENCES')
        .from('from')
        .property('id', existingSelection.id)
        .property('documentId', existingSelection.documentId)
        .property('selectionType', existingSelection.selectionType)
        .property('selectionData', JSON.stringify(existingSelection.selectionData))
        .property('saved', existingSelection.saved.toString())
        .property('provisional', (input.provisional || false).toString())
        .property('resolvedDocumentId', input.documentId)
        .property('resolvedAt', now.toISOString())
        .property('createdAt', existingSelection.createdAt.toISOString())
        .property('updatedAt', now.toISOString());
      
      // Add optional properties
      if (input.referenceTags) {
        traversal = traversal.property('referenceTags', JSON.stringify(input.referenceTags));
      }
      if (input.entityTypes) {
        traversal = traversal.property('entityTypes', JSON.stringify(input.entityTypes));
      }
      if (input.confidence !== undefined) {
        traversal = traversal.property('confidence', input.confidence.toString());
      }
      if (input.resolvedBy) {
        traversal = traversal.property('resolvedBy', input.resolvedBy);
      }
      
      // Preserve existing metadata and merge new
      const metadata = input.metadata || existingSelection.metadata ? 
        { ...existingSelection.metadata, ...input.metadata } : undefined;
      if (metadata) {
        traversal = traversal.property('metadata', JSON.stringify(metadata));
      }
      
      const result = await traversal.elementMap().next();
      
      return edgeToSelection(result.value);
    } catch (error) {
      console.error('Failed to resolve selection in Neptune:', error);
      throw error;
    }
  }
  
  async getReferences(documentId: string): Promise<Selection[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Document')
        .has('id', documentId)
        .outE('REFERENCES')
        .elementMap()
        .toList();
      
      return results.map(edgeToSelection);
    } catch (error) {
      console.error('Failed to get references from Neptune:', error);
      throw error;
    }
  }
  
  async getEntityReferences(documentId: string, entityTypes?: string[]): Promise<Selection[]> {
    try {
      let traversal = this.g.V()
        .hasLabel('Document')
        .has('id', documentId)
        .outE('REFERENCES')
        .has('entityTypes');
      
      if (entityTypes && entityTypes.length > 0) {
        traversal = traversal.filter(
          process.statics.or(
            ...entityTypes.map((type: string) =>
              process.statics.has('entityTypes', TextP.containing(`"${type}"`))
            )
          )
        );
      }
      
      const results = await traversal.elementMap().toList();
      
      return results.map(edgeToSelection);
    } catch (error) {
      console.error('Failed to get entity references from Neptune:', error);
      throw error;
    }
  }
  
  async getDocumentSelections(documentId: string): Promise<Selection[]> {
    try {
      const results = await this.g.E()
        .has('documentId', documentId)
        .elementMap()
        .toList();
      
      return results.map(edgeToSelection);
    } catch (error) {
      console.error('Failed to get document selections from Neptune:', error);
      throw error;
    }
  }
  
  async getDocumentReferencedBy(documentId: string): Promise<Selection[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Document')
        .has('id', documentId)
        .inE('REFERENCES')
        .elementMap()
        .toList();
      
      return results.map(edgeToSelection);
    } catch (error) {
      console.error('Failed to get document referenced by from Neptune:', error);
      throw error;
    }
  }
  
  async getDocumentConnections(documentId: string): Promise<GraphConnection[]> {
    try {
      // Get all outgoing references
      const outgoingRefs = await this.g.V()
        .hasLabel('Document')
        .has('id', documentId)
        .outE('REFERENCES')
        .as('edge')
        .inV()
        .as('target')
        .select('edge', 'target')
        .by(process.statics.elementMap())
        .toList();
      
      // Get all incoming references
      const incomingRefs = await this.g.V()
        .hasLabel('Document')
        .has('id', documentId)
        .inE('REFERENCES')
        .as('edge')
        .outV()
        .as('source')
        .select('edge', 'source')
        .by(process.statics.elementMap())
        .toList();
      
      // Build connections map
      const connectionsMap = new Map<string, GraphConnection>();
      
      // Process outgoing references
      for (const ref of outgoingRefs) {
        const targetDoc = vertexToDocument(ref.target);
        const selection = edgeToSelection(ref.edge);
        
        const existing = connectionsMap.get(targetDoc.id);
        if (existing) {
          existing.selections.push(selection);
        } else {
          connectionsMap.set(targetDoc.id, {
            targetDocument: targetDoc,
            selections: [selection],
            bidirectional: false,
          });
        }
      }
      
      // Check for bidirectional connections
      for (const ref of incomingRefs) {
        const sourceDoc = vertexToDocument(ref.source);
        const existing = connectionsMap.get(sourceDoc.id);
        if (existing) {
          existing.bidirectional = true;
        }
      }
      
      return Array.from(connectionsMap.values());
    } catch (error) {
      console.error('Failed to get document connections from Neptune:', error);
      throw error;
    }
  }
  
  async findPath(fromDocumentId: string, toDocumentId: string, maxDepth: number = 5): Promise<GraphPath[]> {
    try {
      // Use Neptune's optimized path queries
      const results = await this.g.V()
        .hasLabel('Document')
        .has('id', fromDocumentId)
        .repeat(
          process.statics.both('REFERENCES')
            .simplePath()
        )
        .times(maxDepth)
        .emit()
        .has('id', toDocumentId)
        .path()
        .by(process.statics.elementMap())
        .limit(10)
        .toList();
      
      const paths: GraphPath[] = [];
      
      for (const pathResult of results) {
        const documents: Document[] = [];
        const selections: Selection[] = [];
        
        // Process path elements (alternating vertices and edges)
        for (let i = 0; i < pathResult.objects.length; i++) {
          const element = pathResult.objects[i];
          
          if (i % 2 === 0) {
            // Vertex (Document)
            documents.push(vertexToDocument(element));
          } else {
            // Edge (Selection)
            selections.push(edgeToSelection(element));
          }
        }
        
        paths.push({ documents, selections });
      }
      
      return paths;
    } catch (error) {
      console.error('Failed to find paths in Neptune:', error);
      throw error;
    }
  }
  
  async getEntityTypeStats(): Promise<EntityTypeStats[]> {
    try {
      // Use Neptune's analytics capabilities
      const results = await this.g.V()
        .hasLabel('Document')
        .values('entityTypes')
        .map((entityTypesJson: string) => {
          const types = JSON.parse(entityTypesJson);
          return types;
        })
        .unfold()
        .groupCount()
        .next();
      
      const stats: EntityTypeStats[] = [];
      
      if (results.value) {
        for (const [type, count] of Object.entries(results.value)) {
          stats.push({
            type,
            count: count as number,
          });
        }
      }
      
      return stats;
    } catch (error) {
      console.error('Failed to get entity type stats from Neptune:', error);
      throw error;
    }
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
    try {
      // Get document count
      const docCountResult = await this.g.V()
        .hasLabel('Document')
        .count()
        .next();
      const documentCount = docCountResult.value || 0;
      
      // Get selection count
      const selCountResult = await this.g.E()
        .hasLabel('REFERENCES', 'HAS_SELECTION')
        .count()
        .next();
      const selectionCount = selCountResult.value || 0;
      
      // Get highlight count (saved selections without resolved document)
      const highlightCountResult = await this.g.E()
        .hasLabel('HAS_SELECTION')
        .has('saved', 'true')
        .count()
        .next();
      const highlightCount = highlightCountResult.value || 0;
      
      // Get reference count (selections with resolved document)
      const referenceCountResult = await this.g.E()
        .hasLabel('REFERENCES')
        .hasNot('entityTypes')
        .count()
        .next();
      const referenceCount = referenceCountResult.value || 0;
      
      // Get entity reference count
      const entityRefCountResult = await this.g.E()
        .hasLabel('REFERENCES')
        .has('entityTypes')
        .count()
        .next();
      const entityReferenceCount = entityRefCountResult.value || 0;
      
      // Get entity type stats
      const entityTypeStats = await this.getEntityTypeStats();
      const entityTypes: Record<string, number> = {};
      for (const stat of entityTypeStats) {
        entityTypes[stat.type] = stat.count;
      }
      
      // Get content type stats
      const contentTypeResult = await this.g.V()
        .hasLabel('Document')
        .groupCount()
        .by('contentType')
        .next();
      const contentTypes = contentTypeResult.value || {};
      
      return {
        documentCount,
        selectionCount,
        highlightCount,
        referenceCount,
        entityReferenceCount,
        entityTypes,
        contentTypes,
      };
    } catch (error) {
      console.error('Failed to get stats from Neptune:', error);
      throw error;
    }
  }
  
  async createSelections(inputs: CreateSelectionInput[]): Promise<Selection[]> {
    // Use batch operations for better performance
    const results: Selection[] = [];
    
    try {
      // Create all selections in a single traversal
      for (const input of inputs) {
        const selection = await this.createSelection(input);
        results.push(selection);
      }
      
      return results;
    } catch (error) {
      console.error('Failed to create selections in Neptune:', error);
      throw error;
    }
  }
  
  async saveSelections(inputs: SaveSelectionInput[]): Promise<Selection[]> {
    const results: Selection[] = [];
    
    try {
      for (const input of inputs) {
        const selection = await this.saveSelection(input);
        results.push(selection);
      }
      
      return results;
    } catch (error) {
      console.error('Failed to save selections in Neptune:', error);
      throw error;
    }
  }
  
  async resolveSelections(inputs: ResolveSelectionInput[]): Promise<Selection[]> {
    const results: Selection[] = [];
    
    try {
      for (const input of inputs) {
        const selection = await this.resolveSelection(input);
        results.push(selection);
      }
      
      return results;
    } catch (error) {
      console.error('Failed to resolve selections in Neptune:', error);
      throw error;
    }
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
    // Persist to Neptune
    try {
      await this.g.V()
        .has('tagCollection', 'type', 'entity-types')
        .fold()
        .coalesce(
          __.unfold(),
          __.addV('TagCollection').property('type', 'entity-types')
        )
        .property(cardinality.set, 'tags', tag)
        .iterate();
    } catch (error) {
      console.error('Failed to add entity type:', error);
    }
  }
  
  async addReferenceType(tag: string): Promise<void> {
    if (this.referenceTypesCollection === null) {
      await this.initializeTagCollections();
    }
    this.referenceTypesCollection!.add(tag);
    // Persist to Neptune
    try {
      await this.g.V()
        .has('tagCollection', 'type', 'reference-types')
        .fold()
        .coalesce(
          __.unfold(),
          __.addV('TagCollection').property('type', 'reference-types')
        )
        .property(cardinality.set, 'tags', tag)
        .iterate();
    } catch (error) {
      console.error('Failed to add reference type:', error);
    }
  }
  
  async addEntityTypes(tags: string[]): Promise<void> {
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    tags.forEach(tag => this.entityTypesCollection!.add(tag));
    // Persist to Neptune
    try {
      const vertex = await this.g.V()
        .has('tagCollection', 'type', 'entity-types')
        .fold()
        .coalesce(
          __.unfold(),
          __.addV('TagCollection').property('type', 'entity-types')
        );
      
      for (const tag of tags) {
        await vertex.property(cardinality.set, 'tags', tag).iterate();
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
    // Persist to Neptune
    try {
      const vertex = await this.g.V()
        .has('tagCollection', 'type', 'reference-types')
        .fold()
        .coalesce(
          __.unfold(),
          __.addV('TagCollection').property('type', 'reference-types')
        );
      
      for (const tag of tags) {
        await vertex.property(cardinality.set, 'tags', tag).iterate();
      }
    } catch (error) {
      console.error('Failed to add reference types:', error);
    }
  }
  
  private async initializeTagCollections(): Promise<void> {
    try {
      // Check Neptune for existing collections
      const collections = await this.g.V()
        .hasLabel('TagCollection')
        .project('type', 'tags')
        .by('type')
        .by(__.values('tags').fold())
        .toList();
      
      // Process existing collections
      for (const col of collections) {
        if (col.type === 'entity-types') {
          this.entityTypesCollection = new Set(col.tags as string[]);
        } else if (col.type === 'reference-types') {
          this.referenceTypesCollection = new Set(col.tags as string[]);
        }
      }
    } catch (error) {
      console.log('No existing tag collections found, will initialize with defaults');
    }
    
    // Initialize with defaults if not present
    if (this.entityTypesCollection === null) {
      const { DEFAULT_ENTITY_TYPES } = await import('../tag-collections');
      this.entityTypesCollection = new Set(DEFAULT_ENTITY_TYPES);
      // Persist defaults to Neptune
      try {
        const vertex = await this.g.addV('TagCollection')
          .property('type', 'entity-types')
          .next();
        for (const tag of DEFAULT_ENTITY_TYPES) {
          await this.g.V(vertex.value.id)
            .property(cardinality.set, 'tags', tag)
            .iterate();
        }
      } catch (error) {
        console.error('Failed to initialize entity types:', error);
      }
    }
    
    if (this.referenceTypesCollection === null) {
      const { DEFAULT_REFERENCE_TYPES } = await import('../tag-collections');
      this.referenceTypesCollection = new Set(DEFAULT_REFERENCE_TYPES);
      // Persist defaults to Neptune
      try {
        const vertex = await this.g.addV('TagCollection')
          .property('type', 'reference-types')
          .next();
        for (const tag of DEFAULT_REFERENCE_TYPES) {
          await this.g.V(vertex.value.id)
            .property(cardinality.set, 'tags', tag)
            .iterate();
        }
      } catch (error) {
        console.error('Failed to initialize reference types:', error);
      }
    }
  }
  
  generateId(): string {
    return `doc_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  }
  
  async clearDatabase(): Promise<void> {
    try {
      // CAREFUL! This clears the entire graph
      await this.g.V().drop().iterate();
      console.log('Cleared all data from Neptune');
      // Reset tag collections
      this.entityTypesCollection = null;
      this.referenceTypesCollection = null;
    } catch (error) {
      console.error('Failed to clear Neptune database:', error);
      throw error;
    }
  }
}