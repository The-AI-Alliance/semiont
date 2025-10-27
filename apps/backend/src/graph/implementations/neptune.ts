// AWS Neptune implementation of GraphDatabase interface
// Uses Gremlin for graph traversal

import { GraphDatabase } from '../interface';
import { getEntityTypes, getBodySource } from '@semiont/api-client';
import type { components } from '@semiont/api-client';
import type {
  AnnotationCategory,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  DocumentFilter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateAnnotationInternal,
} from '@semiont/core';
import { getExactText } from '@semiont/api-client';
import { v4 as uuidv4 } from 'uuid';
import { getTargetSource, getTargetSelector } from '../../lib/annotation-utils';

type Document = components['schemas']['Document'];
type Annotation = components['schemas']['Annotation'];

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
  const format = getValue('format', true);
  const archived = getValue('archived', true);
  const createdRaw = getValue('created', true);

  const doc: Document = {
    id,
    name,
    entityTypes: JSON.parse(entityTypesRaw),
    format,
    archived: archived === 'true' || archived === true,
    created: createdRaw, // ISO string from DB
    creator: getValue('creator', true),
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
function vertexToAnnotation(vertex: any, entityTypes: string[] = []): Annotation {
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
  const selectorRaw = getValue('selector', true);
  const creatorRaw = getValue('creator', true);
  const createdRaw = getValue('created', true);

  // Derive motivation from type if not present (backward compatibility)
  const motivation = getValue('motivation') || 'linking';

  // Parse creator - always stored as JSON string in DB
  const creator = JSON.parse(creatorRaw);

  // Reconstruct body array from entity tags and linking body
  const bodyArray: Array<{type: 'TextualBody'; value: string; purpose: 'tagging'} | {type: 'SpecificResource'; source: string; purpose: 'linking'}> = [];

  // Add entity tag bodies (TextualBody with purpose: "tagging")
  for (const entityType of entityTypes) {
    if (entityType) {
      bodyArray.push({
        type: 'TextualBody' as const,
        value: entityType,
        purpose: 'tagging' as const,
      });
    }
  }

  // Add linking body (SpecificResource) if annotation is resolved
  const bodySource = getValue('source');
  if (bodySource) {
    bodyArray.push({
      type: 'SpecificResource' as const,
      source: bodySource,
      purpose: 'linking' as const,
    });
  }

  const annotation: Annotation = {
    '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
    'type': 'Annotation' as const,
    id,
    motivation,
    target: {
      source: documentId,
      selector: JSON.parse(selectorRaw),
    },
    body: bodyArray,
    creator,
    created: createdRaw, // ISO string from DB
  };

  // W3C Web Annotation modification tracking
  const modified = getValue('modified');
  if (modified) annotation.modified = modified;

  const generatorJson = getValue('generator');
  if (generatorJson) {
    try {
      annotation.generator = JSON.parse(generatorJson);
    } catch (e) {
      // Ignore parse errors
    }
  }

  return annotation;
}


export class NeptuneGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  private neptuneEndpoint?: string;
  private neptunePort: number = 8182;
  private region?: string;
  private g: any; // Gremlin graph traversal source
  private connection: any; // Gremlin connection

  // Helper method to fetch annotations with their entity types
  private async fetchAnnotationsWithEntityTypes(annotationVertices: any[]): Promise<Annotation[]> {
    const annotations: Annotation[] = [];

    for (const vertex of annotationVertices) {
      const id = vertex.properties?.id?.[0]?.value || vertex.id;

      // Fetch entity types for this annotation
      const entityTypesResult = await this.g.V()
        .hasLabel('Annotation')
        .has('id', id)
        .out('TAGGED_AS')
        .hasLabel('EntityType')
        .values('name')
        .toList();

      const entityTypes = entityTypesResult || [];
      annotations.push(vertexToAnnotation(vertex, entityTypes));
    }

    return annotations;
  }
  
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
      format: input.format,
      archived: false,
      created: now,
      creator: input.creator,
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
        .property('contentType', document.format)
        .property('archived', document.archived)
        .property('created', document.created)
        .property('creator', document.creator)
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
        .order().by('created', order.desc)
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
        .order().by('created', order.desc)
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

    // Only linking motivation with SpecificResource or empty array (stub)
    const annotation: Annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      id,
      motivation: input.motivation,
      target: input.target,
      body: input.body,
      creator: input.creator,
      created: new Date().toISOString(),
    };

    // Extract values for Gremlin query
    const targetSource = getTargetSource(input.target);
    const targetSelector = getTargetSelector(input.target);
    const bodySource = getBodySource(input.body);
    const entityTypes = getEntityTypes(input);

    try {
      // Create Annotation vertex
      const vertex = this.g.addV('Annotation')
        .property('id', annotation.id)
        .property('documentId', targetSource) // Store full URI
        .property('text', targetSelector ? getExactText(targetSelector) : '')
        .property('selector', JSON.stringify(targetSelector || {}))
        .property('type', 'SpecificResource')
        .property('motivation', annotation.motivation)
        .property('creator', JSON.stringify(annotation.creator))
        .property('created', annotation.created);

      // Add optional source property for resolved references
      if (bodySource) {
        vertex.property('source', bodySource);
      }

      const newVertex = await vertex.next();

      // Create edge from Annotation to Document (BELONGS_TO)
      await this.g.V(newVertex.value)
        .addE('BELONGS_TO')
        .to(this.g.V().hasLabel('Document').has('id', targetSource)) // Use full URI
        .next();

      // If it's a resolved reference, create edge to target document (REFERENCES)
      if (bodySource) {
        await this.g.V(newVertex.value)
          .addE('REFERENCES')
          .to(this.g.V().hasLabel('Document').has('id', bodySource)) // Use full URI
          .next();
      }

      // Create TAGGED_AS relationships for entity types
      for (const entityType of entityTypes) {
        // Get or create EntityType vertex
        const etVertex = await this.g.V()
          .hasLabel('EntityType')
          .has('name', entityType)
          .fold()
          .coalesce(
            __.unfold(),
            this.g.addV('EntityType').property('name', entityType)
          )
          .next();

        // Create TAGGED_AS edge from Annotation to EntityType
        await this.g.V(newVertex.value)
          .addE('TAGGED_AS')
          .to(this.g.V(etVertex.value))
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
        .hasLabel('Annotation')
        .has('id', id)
        .elementMap()
        .next();

      if (!result.value) {
        return null;
      }

      // Fetch entity types from TAGGED_AS relationships
      const entityTypesResult = await this.g.V()
        .hasLabel('Annotation')
        .has('id', id)
        .out('TAGGED_AS')
        .hasLabel('EntityType')
        .values('name')
        .toList();

      const entityTypes = entityTypesResult || [];

      return vertexToAnnotation(result.value, entityTypes);
    } catch (error) {
      console.error('Failed to get annotation from Neptune:', error);
      throw error;
    }
  }
  
  async updateAnnotation(id: string, updates: Partial<Annotation>): Promise<Annotation> {
    try {
      let traversal = this.g.V()
        .hasLabel('Annotation')
        .has('id', id);

      // Update target properties
      if (updates.target !== undefined && typeof updates.target !== 'string') {
        if (updates.target.selector !== undefined) {
          traversal = traversal.property('text', getExactText(updates.target.selector));
        }
      }

      // Update body properties and entity types
      if (updates.body !== undefined) {
        const bodySource = getBodySource(updates.body);
        const entityTypes = getEntityTypes({ body: updates.body });

        if (bodySource) {
          traversal = traversal.property('source', bodySource);
        }

        // Update entity type relationships - remove old ones and create new ones
        if (entityTypes.length >= 0) {
          // Remove existing TAGGED_AS edges
          await this.g.V()
            .hasLabel('Annotation')
            .has('id', id)
            .outE('TAGGED_AS')
            .drop()
            .iterate();

          // Create new TAGGED_AS edges
          for (const entityType of entityTypes) {
            const etVertex = await this.g.V()
              .hasLabel('EntityType')
              .has('name', entityType)
              .fold()
              .coalesce(
                __.unfold(),
                this.g.addV('EntityType').property('name', entityType)
              )
              .next();

            await this.g.V()
              .hasLabel('Annotation')
              .has('id', id)
              .addE('TAGGED_AS')
              .to(this.g.V(etVertex.value))
              .next();
          }
        }
      }

      if (updates.modified !== undefined) {
        traversal = traversal.property('modified', updates.modified);
      }
      if (updates.generator !== undefined) {
        traversal = traversal.property('generator', JSON.stringify(updates.generator));
      }

      const result = await traversal.elementMap().next();

      if (!result.value) {
        throw new Error('Annotation not found');
      }

      // Fetch entity types from TAGGED_AS relationships
      const entityTypesResult = await this.g.V()
        .hasLabel('Annotation')
        .has('id', id)
        .out('TAGGED_AS')
        .hasLabel('EntityType')
        .values('name')
        .toList();

      const entityTypes = entityTypesResult || [];

      return vertexToAnnotation(result.value, entityTypes);
    } catch (error) {
      console.error('Failed to update annotation in Neptune:', error);
      throw error;
    }
  }
  
  async deleteAnnotation(id: string): Promise<void> {
    try {
      await this.g.V()
        .hasLabel('Annotation')
        .has('id', id)
        .drop()
        .iterate();
      
      console.log(`Deleted annotation from Neptune: ${id}`);
    } catch (error) {
      console.error('Failed to delete annotation from Neptune:', error);
      throw error;
    }
  }
  
  async listAnnotations(filter: { documentId?: string; type?: AnnotationCategory }): Promise<{ annotations: Annotation[]; total: number }> {
    try {
      let traversal = this.g.V().hasLabel('Annotation');

      // Apply filters
      if (filter.documentId) {
        traversal = traversal.has('documentId', filter.documentId);
      }

      if (filter.type) {
        const w3cType = filter.type === 'highlight' ? 'TextualBody' : 'SpecificResource';
        traversal = traversal.has('type', w3cType);
      }

      const results = await traversal.elementMap().toList();
      const annotations = await this.fetchAnnotationsWithEntityTypes(results);

      return { annotations, total: annotations.length };
    } catch (error) {
      console.error('Failed to list annotations from Neptune:', error);
      throw error;
    }
  }
  
  
  async getHighlights(documentId: string): Promise<Annotation[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Annotation')
        .has('documentId', documentId)
        .hasNot('resolvedDocumentId')
        .elementMap()
        .toList();

      return await this.fetchAnnotationsWithEntityTypes(results);
    } catch (error) {
      console.error('Failed to get highlights from Neptune:', error);
      throw error;
    }
  }
  
  async resolveReference(annotationId: string, source: string): Promise<Annotation> {
    try {
      // Get target document name
      const targetDocResult = await this.g.V()
        .hasLabel('Document')
        .has('id', source)
        .elementMap()
        .next();
      const targetDoc = targetDocResult.value ? vertexToDocument(targetDocResult.value) : null;

      // Update the existing Annotation vertex
      const traversal = this.g.V()
        .hasLabel('Annotation')
        .has('id', annotationId)
        .property('source', source)
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
        .to(this.g.V().hasLabel('Document').has('id', source))
        .next();

      // Fetch entity types from TAGGED_AS relationships
      const entityTypesResult = await this.g.V()
        .hasLabel('Annotation')
        .has('id', annotationId)
        .out('TAGGED_AS')
        .hasLabel('EntityType')
        .values('name')
        .toList();

      const entityTypes = entityTypesResult || [];

      return vertexToAnnotation(result.value, entityTypes);
    } catch (error) {
      console.error('Failed to resolve reference in Neptune:', error);
      throw error;
    }
  }
  
  async getReferences(documentId: string): Promise<Annotation[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Annotation')
        .has('documentId', documentId)
        .has('resolvedDocumentId')
        .elementMap()
        .toList();

      return await this.fetchAnnotationsWithEntityTypes(results);
    } catch (error) {
      console.error('Failed to get references from Neptune:', error);
      throw error;
    }
  }
  
  async getEntityReferences(documentId: string, entityTypes?: string[]): Promise<Annotation[]> {
    try {
      let traversal = this.g.V()
        .hasLabel('Annotation')
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

      return await this.fetchAnnotationsWithEntityTypes(results);
    } catch (error) {
      console.error('Failed to get entity references from Neptune:', error);
      throw error;
    }
  }
  
  async getDocumentAnnotations(documentId: string): Promise<Annotation[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Annotation')
        .has('documentId', documentId)
        .elementMap()
        .toList();

      return await this.fetchAnnotationsWithEntityTypes(results);
    } catch (error) {
      console.error('Failed to get document annotations from Neptune:', error);
      throw error;
    }
  }
  
  async getDocumentReferencedBy(documentId: string): Promise<Annotation[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Annotation')
        .has('resolvedDocumentId', documentId)
        .elementMap()
        .toList();

      return await this.fetchAnnotationsWithEntityTypes(results);
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
        .has('source')
        .elementMap()
        .toList();

      // Get all annotations that reference this document
      const incomingAnnotations = await this.g.V()
        .hasLabel('Annotation')
        .has('source', documentId)
        .elementMap()
        .toList();

      // Build connections map
      const connectionsMap = new Map<string, GraphConnection>();

      // Process outgoing references
      for (const annVertex of outgoingAnnotations) {
        const id = annVertex.properties?.id?.[0]?.value || annVertex.id;

        // Fetch entity types for this annotation
        const entityTypesResult = await this.g.V()
          .hasLabel('Annotation')
          .has('id', id)
          .out('TAGGED_AS')
          .hasLabel('EntityType')
          .values('name')
          .toList();

        const entityTypes = entityTypesResult || [];
        const annotation = vertexToAnnotation(annVertex, entityTypes);
        const targetDocId = getBodySource(annotation.body);
        if (!targetDocId) continue; // Skip stubs

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
        const id = annVertex.properties?.id?.[0]?.value || annVertex.id;

        // Fetch entity types for this annotation
        const entityTypesResult = await this.g.V()
          .hasLabel('Annotation')
          .has('id', id)
          .out('TAGGED_AS')
          .hasLabel('EntityType')
          .values('name')
          .toList();

        const entityTypes = entityTypesResult || [];
        const annotation = vertexToAnnotation(annVertex, entityTypes);
        const sourceDocId = getTargetSource(annotation.target);
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
      
      // Get annotation count
      const selCountResult = await this.g.V()
        .hasLabel('Annotation')
        .count()
        .next();
      const annotationCount = selCountResult.value || 0;

      // Get highlight count (annotations without resolved document)
      const highlightCountResult = await this.g.V()
        .hasLabel('Annotation')
        .hasNot('resolvedDocumentId')
        .count()
        .next();
      const highlightCount = highlightCountResult.value || 0;

      // Get reference count (annotations with resolved document)
      const referenceCountResult = await this.g.V()
        .hasLabel('Annotation')
        .has('resolvedDocumentId')
        .count()
        .next();
      const referenceCount = referenceCountResult.value || 0;

      // Get entity reference count
      const entityRefCountResult = await this.g.V()
        .hasLabel('Annotation')
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


  async resolveReferences(inputs: { annotationId: string; source: string }[]): Promise<Annotation[]> {
    const results: Annotation[] = [];

    try {
      for (const input of inputs) {
        const annotation = await this.resolveReference(input.annotationId, input.source);
        results.push(annotation);
      }

      return results;
    } catch (error) {
      console.error('Failed to resolve references in Neptune:', error);
      throw error;
    }
  }
  
  async detectAnnotations(_documentId: string): Promise<Annotation[]> {
    // This would use AI/ML to detect annotations in a document
    // For now, return empty array as a placeholder
    return [];
  }
  
  // Tag Collections - stored as special vertices in the graph
  private entityTypesCollection: Set<string> | null = null;
  
  async getEntityTypes(): Promise<string[]> {
    // Initialize if not already loaded
    if (this.entityTypesCollection === null) {
      await this.initializeTagCollections();
    }
    return Array.from(this.entityTypesCollection!).sort();
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
    } catch (error) {
      console.error('Failed to clear Neptune database:', error);
      throw error;
    }
  }
}