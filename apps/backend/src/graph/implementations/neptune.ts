// AWS Neptune implementation of GraphDatabase interface
// Uses Gremlin for graph traversal

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
  const getValue = (key: string, required: boolean = false) => {
    const prop = props[key];
    if (!prop) {
      if (required) {
        throw new Error(`Document ${vertex.id || 'unknown'} missing required field: ${key}`);
      }
      return undefined;
    }
    if (Array.isArray(prop) && prop.length > 0) {
      return prop[0].value !== undefined ? prop[0].value : prop[0];
    }
    return prop.value !== undefined ? prop.value : prop;
  };
  
  // Get all required fields and validate
  const id = getValue('id', true);
  const name = getValue('name', true);
  const entityTypesRaw = getValue('entityTypes', true);
  const contentType = getValue('contentType', true);
  const archived = getValue('archived', true);
  const createdAtRaw = getValue('createdAt', true);

  const doc: Document = {
    id,
    name,
    entityTypes: JSON.parse(entityTypesRaw),
    contentType,
    archived: archived === 'true' || archived === true,
    createdAt: createdAtRaw, // ISO string from DB
    createdBy: getValue('createdBy', true),
    creationMethod: getValue('creationMethod', true),
    contentChecksum: getValue('contentChecksum', true),
  };

  const sourceAnnotationId = getValue('sourceAnnotationId');
  if (sourceAnnotationId) doc.sourceAnnotationId = sourceAnnotationId;

  const sourceDocumentId = getValue('sourceDocumentId');
  if (sourceDocumentId) doc.sourceDocumentId = sourceDocumentId;

  return doc;
}

// Helper function to convert Neptune vertex to Annotation
function vertexToAnnotation(vertex: any): Annotation {
  const props = vertex.properties || vertex;

  // Handle different property formats from Neptune
  const getValue = (key: string, required: boolean = false) => {
    const prop = props[key];
    if (!prop) {
      if (required) {
        throw new Error(`Annotation ${vertex.id || 'unknown'} missing required field: ${key}`);
      }
      return undefined;
    }
    if (Array.isArray(prop) && prop.length > 0) {
      return prop[0].value !== undefined ? prop[0].value : prop[0];
    }
    if (typeof prop === 'object' && 'value' in prop) return prop.value;
    return prop;
  };

  // Get required fields
  const id = getValue('id', true);
  const documentId = getValue('documentId', true);
  const text = getValue('text', true);
  const type = getValue('type', true) as 'highlight' | 'reference';
  const selectorRaw = getValue('selector', true);
  const createdBy = getValue('createdBy', true);
  const createdAtRaw = getValue('createdAt', true);

  const annotation: Annotation = {
    id,
    target: {
      source: documentId,
      selector: JSON.parse(selectorRaw),
    },
    body: {
      type,
      entityTypes: [],
      referenceType: getValue('referenceType'),
      referencedDocumentId: getValue('referencedDocumentId'),
    },
    createdBy,
    createdAt: createdAtRaw, // ISO string from DB
  };

  // Optional top-level fields
  const resolvedDocumentName = getValue('resolvedDocumentName');
  if (resolvedDocumentName) annotation.resolvedDocumentName = resolvedDocumentName;

  const resolvedAt = getValue('resolvedAt');
  if (resolvedAt) annotation.resolvedAt = resolvedAt; // ISO string from DB

  const resolvedBy = getValue('resolvedBy');
  if (resolvedBy) annotation.resolvedBy = resolvedBy;

  const entityTypes = getValue('entityTypes');
  if (entityTypes) annotation.body.entityTypes = JSON.parse(entityTypes);

  return annotation;
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
    };
    if (input.sourceAnnotationId) document.sourceAnnotationId = input.sourceAnnotationId;
    if (input.sourceDocumentId) document.sourceDocumentId = input.sourceDocumentId;

    // Create vertex in Neptune
    try {
      const vertex = this.g.addV('Document')
        .property('id', document.id)
        .property('name', document.name)
        .property('contentType', document.contentType)
        .property('archived', document.archived)
        .property('createdAt', document.createdAt)
        .property('createdBy', document.createdBy)
        .property('creationMethod', document.creationMethod)
        .property('contentChecksum', document.contentChecksum)
        .property('entityTypes', JSON.stringify(document.entityTypes));

      if (document.sourceAnnotationId) {
        vertex.property('sourceAnnotationId', document.sourceAnnotationId);
      }
      if (document.sourceDocumentId) {
        vertex.property('sourceDocumentId', document.sourceDocumentId);
      }

      await vertex.next();
      
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
    // Documents are immutable - only archiving is allowed
    if (Object.keys(input).length !== 1 || input.archived === undefined) {
      throw new Error('Documents are immutable. Only archiving is allowed.');
    }

    try {
      const result = await this.g.V()
        .hasLabel('Document')
        .has('id', id)
        .property('archived', input.archived)
        .elementMap()
        .next();

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

    try {
      // Create Annotation vertex
      const vertex = this.g.addV('Annotation')
        .property('id', annotation.id)
        .property('documentId', annotation.target.source)
        .property('text', annotation.target.selector.exact)
        .property('selector', JSON.stringify(annotation.target.selector))
        .property('type', annotation.body.type)
        .property('createdBy', annotation.createdBy)
        .property('createdAt', annotation.createdAt)
        .property('entityTypes', JSON.stringify(annotation.body.entityTypes));

      // Add optional properties
      if (annotation.body.referenceType) {
        vertex.property('referenceType', annotation.body.referenceType);
      }
      if (annotation.body.referencedDocumentId) {
        vertex.property('referencedDocumentId', annotation.body.referencedDocumentId);
      }

      const newVertex = await vertex.next();

      // Create edge from Annotation to Document (BELONGS_TO)
      await this.g.V(newVertex.value)
        .addE('BELONGS_TO')
        .to(this.g.V().hasLabel('Document').has('id', input.target.source))
        .next();

      // If it's a reference, create edge to target document (REFERENCES)
      if (input.body.referencedDocumentId) {
        await this.g.V(newVertex.value)
          .addE('REFERENCES')
          .to(this.g.V().hasLabel('Document').has('id', input.body.referencedDocumentId))
          .next();
      }

      console.log(`Created annotation vertex in Neptune: ${annotation.id}`);
      return annotation;
    } catch (error) {
      console.error('Failed to create annotation in Neptune:', error);
      throw error;
    }
  }
  
  async getAnnotation(id: string): Promise<Annotation | null> {
    try {
      const result = await this.g.V()
        .hasLabel('Selection')
        .has('id', id)
        .elementMap()
        .next();
      
      if (!result.value) {
        return null;
      }
      
      return vertexToAnnotation(result.value);
    } catch (error) {
      console.error('Failed to get selection from Neptune:', error);
      throw error;
    }
  }
  
  async updateAnnotation(id: string, updates: Partial<Annotation>): Promise<Annotation> {
    try {
      let traversal = this.g.V()
        .hasLabel('Annotation')
        .has('id', id);

      // Update properties
      if (updates.exact !== undefined) {
        traversal = traversal.property('text', updates.exact);
      }
      if (updates.type !== undefined) {
        traversal = traversal.property('type', updates.type);
      }
      if (updates.referencedDocumentId !== undefined) {
        traversal = traversal.property('referencedDocumentId', updates.referencedDocumentId);
      }
      if (updates.resolvedDocumentName !== undefined) {
        traversal = traversal.property('resolvedDocumentName', updates.resolvedDocumentName);
      }
      if (updates.referenceType !== undefined) {
        traversal = traversal.property('referenceType', updates.referenceType);
      }
      if (updates.entityTypes !== undefined) {
        traversal = traversal.property('entityTypes', JSON.stringify(updates.entityTypes));
      }
      if (updates.resolvedBy !== undefined) {
        traversal = traversal.property('resolvedBy', updates.resolvedBy);
      }
      if (updates.resolvedAt !== undefined) {
        traversal = traversal.property('resolvedAt', updates.resolvedAt);
      }

      const result = await traversal.elementMap().next();

      if (!result.value) {
        throw new Error('Annotation not found');
      }

      return vertexToAnnotation(result.value);
    } catch (error) {
      console.error('Failed to update annotation in Neptune:', error);
      throw error;
    }
  }
  
  async deleteAnnotation(id: string): Promise<void> {
    try {
      await this.g.V()
        .hasLabel('Selection')
        .has('id', id)
        .drop()
        .iterate();
      
      console.log(`Deleted selection from Neptune: ${id}`);
    } catch (error) {
      console.error('Failed to delete selection from Neptune:', error);
      throw error;
    }
  }
  
  async listAnnotations(filter: { documentId?: string; type?: 'highlight' | 'reference' }): Promise<{ annotations: Annotation[]; total: number }> {
    try {
      let traversal = this.g.V().hasLabel('Annotation');

      // Apply filters
      if (filter.documentId) {
        traversal = traversal.has('documentId', filter.documentId);
      }

      if (filter.type) {
        traversal = traversal.has('type', filter.type);
      }

      const results = await traversal.elementMap().toList();
      const annotations = results.map(vertexToAnnotation);

      return { annotations, total: annotations.length };
    } catch (error) {
      console.error('Failed to list selections from Neptune:', error);
      throw error;
    }
  }
  
  
  async getHighlights(documentId: string): Promise<Annotation[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Selection')
        .has('documentId', documentId)
        .hasNot('resolvedDocumentId')
        .elementMap()
        .toList();

      return results.map(vertexToAnnotation);
    } catch (error) {
      console.error('Failed to get highlights from Neptune:', error);
      throw error;
    }
  }
  
  async resolveReference(annotationId: string, referencedDocumentId: string): Promise<Annotation> {
    try {
      // Get target document name
      const targetDocResult = await this.g.V()
        .hasLabel('Document')
        .has('id', referencedDocumentId)
        .elementMap()
        .next();
      const targetDoc = targetDocResult.value ? vertexToDocument(targetDocResult.value) : null;

      // Update the existing Annotation vertex
      const traversal = this.g.V()
        .hasLabel('Annotation')
        .has('id', annotationId)
        .property('referencedDocumentId', referencedDocumentId)
        .property('resolvedDocumentName', targetDoc?.name)
        .property('resolvedAt', new Date().toISOString());

      const result = await traversal.elementMap().next();

      if (!result.value) {
        throw new Error('Annotation not found');
      }

      // Create REFERENCES edge to the resolved document
      const annVertex = await this.g.V()
        .hasLabel('Annotation')
        .has('id', annotationId)
        .next();

      await this.g.V(annVertex.value)
        .addE('REFERENCES')
        .to(this.g.V().hasLabel('Document').has('id', referencedDocumentId))
        .next();

      return vertexToAnnotation(result.value);
    } catch (error) {
      console.error('Failed to resolve reference in Neptune:', error);
      throw error;
    }
  }
  
  async getReferences(documentId: string): Promise<Annotation[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Selection')
        .has('documentId', documentId)
        .has('resolvedDocumentId')
        .elementMap()
        .toList();

      return results.map(vertexToAnnotation);
    } catch (error) {
      console.error('Failed to get references from Neptune:', error);
      throw error;
    }
  }
  
  async getEntityReferences(documentId: string, entityTypes?: string[]): Promise<Annotation[]> {
    try {
      let traversal = this.g.V()
        .hasLabel('Selection')
        .has('documentId', documentId)
        .has('resolvedDocumentId')
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

      return results.map(vertexToAnnotation);
    } catch (error) {
      console.error('Failed to get entity references from Neptune:', error);
      throw error;
    }
  }
  
  async getDocumentAnnotations(documentId: string): Promise<Annotation[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Selection')
        .has('documentId', documentId)
        .elementMap()
        .toList();

      return results.map(vertexToAnnotation);
    } catch (error) {
      console.error('Failed to get document selections from Neptune:', error);
      throw error;
    }
  }
  
  async getDocumentReferencedBy(documentId: string): Promise<Annotation[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Selection')
        .has('resolvedDocumentId', documentId)
        .elementMap()
        .toList();

      return results.map(vertexToAnnotation);
    } catch (error) {
      console.error('Failed to get document referenced by from Neptune:', error);
      throw error;
    }
  }
  
  async getDocumentConnections(documentId: string): Promise<GraphConnection[]> {
    try {
      // Get all annotations from this document that reference other documents
      const outgoingAnnotations = await this.g.V()
        .hasLabel('Annotation')
        .has('documentId', documentId)
        .has('referencedDocumentId')
        .elementMap()
        .toList();

      // Get all annotations that reference this document
      const incomingAnnotations = await this.g.V()
        .hasLabel('Annotation')
        .has('referencedDocumentId', documentId)
        .elementMap()
        .toList();

      // Build connections map
      const connectionsMap = new Map<string, GraphConnection>();

      // Process outgoing references
      for (const annVertex of outgoingAnnotations) {
        const annotation = vertexToAnnotation(annVertex);
        const targetDocId = annotation.referencedDocumentId!;

        // Get the target document
        const targetDocResult = await this.g.V()
          .hasLabel('Document')
          .has('id', targetDocId)
          .elementMap()
          .next();

        if (targetDocResult.value) {
          const targetDoc = vertexToDocument(targetDocResult.value);
          const existing = connectionsMap.get(targetDoc.id);
          if (existing) {
            existing.annotations.push(annotation);
          } else {
            connectionsMap.set(targetDoc.id, {
              targetDocument: targetDoc,
              annotations: [annotation],
              bidirectional: false,
            });
          }
        }
      }

      // Check for bidirectional connections
      for (const annVertex of incomingAnnotations) {
        const annotation = vertexToAnnotation(annVertex);
        const sourceDocId = annotation.documentId;
        const existing = connectionsMap.get(sourceDocId);
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

        // Process path elements (alternating vertices and edges)
        for (let i = 0; i < pathResult.objects.length; i++) {
          const element = pathResult.objects[i];

          if (i % 2 === 0) {
            // Vertex (Document)
            documents.push(vertexToDocument(element));
          } else {
            // Edge - skip for now as we're using vertex-based annotations
            // We'd need to query for annotations between documents
          }
        }

        paths.push({ documents, annotations: [] });
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
    annotationCount: number;
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
      const selCountResult = await this.g.V()
        .hasLabel('Selection')
        .count()
        .next();
      const annotationCount = selCountResult.value || 0;

      // Get highlight count (selections without resolved document)
      const highlightCountResult = await this.g.V()
        .hasLabel('Selection')
        .hasNot('resolvedDocumentId')
        .count()
        .next();
      const highlightCount = highlightCountResult.value || 0;

      // Get reference count (selections with resolved document)
      const referenceCountResult = await this.g.V()
        .hasLabel('Selection')
        .has('resolvedDocumentId')
        .count()
        .next();
      const referenceCount = referenceCountResult.value || 0;

      // Get entity reference count
      const entityRefCountResult = await this.g.V()
        .hasLabel('Selection')
        .has('resolvedDocumentId')
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
        annotationCount,
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
  
  async createAnnotations(inputs: CreateAnnotationInternal[]): Promise<Annotation[]> {
    const results: Annotation[] = [];

    try {
      for (const input of inputs) {
        const annotation = await this.createAnnotation(input);
        results.push(annotation);
      }

      return results;
    } catch (error) {
      console.error('Failed to create annotations in Neptune:', error);
      throw error;
    }
  }


  async resolveReferences(inputs: { annotationId: string; referencedDocumentId: string }[]): Promise<Annotation[]> {
    const results: Annotation[] = [];

    try {
      for (const input of inputs) {
        const annotation = await this.resolveReference(input.annotationId, input.referencedDocumentId);
        results.push(annotation);
      }

      return results;
    } catch (error) {
      console.error('Failed to resolve references in Neptune:', error);
      throw error;
    }
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
    return uuidv4().replace(/-/g, '').substring(0, 12);
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