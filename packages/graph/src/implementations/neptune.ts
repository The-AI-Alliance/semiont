// AWS Neptune implementation of GraphDatabase interface
// Uses Gremlin for graph traversal

import { GraphDatabase } from '../interface';
import { assertMutableResourceUpdate } from '../interface';
import { queryResources } from '../resource-query';
import { getEntityTypes } from '@semiont/ontology';
import type { Logger } from '@semiont/core';
import {
  buildAnnotation,
  decodeAnnotation,
  encodeAnnotation,
  encodeSelector,
  motivationForCategory,
  storedAnnotationType,
  type AnnotationProperties,
} from '../annotation-codec';
import type {
  AnnotationCategory,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  ResourceFilter,
  UpdateResourceInput,
  CreateAnnotationInternal,
  ResourceId,
  AnnotationId,
} from '@semiont/core';
import { v4 as uuidv4 } from 'uuid';
import { getBodySource, getTargetSource, getPrimaryRepresentation, getResourceId, getStorageUri } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';
import type { Annotation } from '@semiont/core';

// Dynamic imports for AWS SDK and Gremlin
let NeptuneClient: any;
let DescribeDBClustersCommand: any;
let gremlin: any;
let process: any;
let TextP: any;
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
    cardinality = process.cardinality;
    __ = process.statics;
  }
}

// Helper function to convert Neptune vertex to ResourceDescriptor
function vertexToResource(vertex: any): ResourceDescriptor {
  const props = vertex.properties || vertex;

  // Handle different property formats from Neptune
  const getValue = (key: string, required: boolean = false) => {
    const prop = props[key];
    if (!prop) {
      if (required) {
        throw new Error(`Resource ${vertex.id || 'unknown'} missing required field: ${key}`);
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
  const mediaType = getValue('mediaType', true);
  const archived = getValue('archived', true);
  const dateCreated = getValue('dateCreated', true);
  const checksum = getValue('checksum', true);
  const creatorRaw = getValue('creator', true);

  const resource: ResourceDescriptor = {
    '@context': 'https://schema.org/',
    '@id': id,
    name,
    entityTypes: JSON.parse(entityTypesRaw),
    representations: [{
      mediaType,
      checksum,
      rel: 'original',
      storageUri: getValue('storageUri') || undefined,
    }],
    archived: archived === 'true' || archived === true,
    dateCreated,
    wasAttributedTo: typeof creatorRaw === 'string' ? JSON.parse(creatorRaw) : creatorRaw,
  };

  const sourceResourceId = getValue('sourceResourceId');
  if (sourceResourceId) resource.sourceResourceId = sourceResourceId;

  return resource;
}

/**
 * Convert a Neptune vertex to an Annotation.
 *
 * Exported so the cross-store conformance suite can run this store's decode
 * path with no live Neptune: everything past the flattening below is the
 * shared codec's.
 */
export function vertexToAnnotation(vertex: any, entityTypes: string[] = []): Annotation {
  return decodeAnnotation(normalizeProperties(vertex.properties || vertex), entityTypes);
}

/** Neptune returns each property in one of several shapes depending on the traversal. */
function normalizeProperties(props: any): AnnotationProperties {
  const normalized: AnnotationProperties = {};
  for (const [key, raw] of Object.entries(props ?? {})) {
    const value = unwrap(raw);
    if (value === undefined || value === null) continue;
    normalized[key] = typeof value === 'string' ? value : String(value);
  }
  return normalized;
}

function unwrap(prop: any): any {
  if (prop === undefined || prop === null) return undefined;
  if (Array.isArray(prop)) return prop.length > 0 ? unwrap(prop[0]) : undefined;
  if (typeof prop === 'object' && 'value' in prop) return prop.value;
  return prop;
}


export class NeptuneGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  private neptuneEndpoint?: string;
  private neptunePort: number = 8182;
  private region?: string;
  private logger?: Logger;
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
    logger?: Logger;
  } = {}) {
    if (config.endpoint) this.neptuneEndpoint = config.endpoint;
    this.neptunePort = config.port || 8182;
    if (config.region) this.region = config.region;
    this.logger = config.logger;
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

      this.logger?.info('Discovered Neptune endpoint', { endpoint: this.neptuneEndpoint, port: this.neptunePort });
    } catch (error: any) {
      this.logger?.error('Failed to discover Neptune endpoint', { error });
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
      this.logger?.info('Connecting to Neptune', { connectionUrl });

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
      this.logger?.info('Connected to Neptune', { vertexCountTest: count.value });

      this.connected = true;
    } catch (error: any) {
      this.logger?.error('Failed to connect to Neptune', { error });
      throw error;
    }
  }
  
  async disconnect(): Promise<void> {
    // Close Gremlin connection if it exists
    if (this.connection) {
      try {
        await this.connection.close();
      } catch (error) {
        this.logger?.error('Error closing Neptune connection', { error });
      }
    }

    this.connected = false;
    this.logger?.info('Disconnected from Neptune');
  }
  
  isConnected(): boolean {
    return this.connected;
  }

  async createResource(resource: ResourceDescriptor): Promise<ResourceDescriptor> {
    const id = getResourceId(resource);
    const primaryRep = getPrimaryRepresentation(resource);
    if (!primaryRep) {
      throw new Error('Resource must have at least one representation');
    }

    // Create vertex in Neptune
    try {
      const vertex = this.g.addV('Resource')
        .property('id', id)
        .property('name', resource.name)
        .property('mediaType', primaryRep.mediaType)
        .property('archived', resource.archived || false)
        .property('dateCreated', resource.dateCreated)
        .property('creator', JSON.stringify(resource.wasAttributedTo))
        .property('checksum', primaryRep.checksum)
        .property('entityTypes', JSON.stringify(resource.entityTypes));

      if (resource.sourceResourceId) {
        vertex.property('sourceResourceId', resource.sourceResourceId);
      }
      const storageUri = getStorageUri(resource);
      if (storageUri) {
        vertex.property('storageUri', storageUri);
      }

      await vertex.next();

      this.logger?.info('Created resource vertex in Neptune', { id });
      return resource;
    } catch (error) {
      this.logger?.error('Failed to create resource in Neptune', { error });
      throw error;
    }
  }
  
  async getResource(id: ResourceId): Promise<ResourceDescriptor | null> {
    try {
      const result = await this.g.V()
        .hasLabel('Resource')
        .has('id', id)
        .elementMap()
        .next();
      
      if (!result.value) {
        return null;
      }
      
      return vertexToResource(result.value);
    } catch (error) {
      this.logger?.error('Failed to get resource from Neptune', { error });
      throw error;
    }
  }
  
  async updateResource(id: ResourceId, input: UpdateResourceInput): Promise<ResourceDescriptor> {
    assertMutableResourceUpdate(input);

    try {
      let traversal = this.g.V()
        .hasLabel('Resource')
        .has('id', id);
      if (input.archived !== undefined) {
        traversal = traversal.property('archived', input.archived);
      }
      if (input.entityTypes !== undefined) {
        // Mirrors createResource's storage idiom: entityTypes ride as JSON.
        traversal = traversal.property('entityTypes', JSON.stringify(input.entityTypes));
      }
      const result = await traversal
        .elementMap()
        .next();

      if (!result.value) {
        throw new Error('Resource not found');
      }

      return vertexToResource(result.value);
    } catch (error) {
      this.logger?.error('Failed to update resource in Neptune', { error });
      throw error;
    }
  }
  
  async deleteResource(id: ResourceId): Promise<void> {
    try {
      // Delete the resource vertex and all connected edges
      await this.g.V()
        .hasLabel('Resource')
        .has('id', id)
        .drop()
        .iterate();

      this.logger?.info('Deleted resource from Neptune', { id });
    } catch (error) {
      this.logger?.error('Failed to delete resource from Neptune', { error });
      throw error;
    }
  }
  
  /**
   * Filtering, ranking and pagination happen in JS rather than in Gremlin.
   *
   * The ranking ladder (exact name over prefix over substring over path- or
   * tag-assisted) has no natural Gremlin expression, and a rank applied after
   * `range()` would order one page instead of the match set. JanusGraph
   * post-filters for the same reason. Both share `queryResources` with the
   * memory backend so search cannot mean three different things across three
   * gateways.
   *
   * The cost is explicit and accepted: this materializes every `Resource`
   * vertex per call, so it is O(N) in the size of the KB rather than in the
   * size of the result. Neo4j is the production path and pushes the whole
   * query — filter, rank, page — into Cypher; Neptune and JanusGraph are not
   * deployment targets today. If either becomes one at scale, the fix is a
   * Gremlin rank expression (`choose` over `toLower`, engine-version
   * permitting), not a return to per-gateway search semantics.
   */
  async listResources(filter: ResourceFilter): Promise<{ resources: ResourceDescriptor[]; total: number }> {
    try {
      const results = await this.g.V().hasLabel('Resource').elementMap().toList();
      return queryResources(results.map(vertexToResource), filter);
    } catch (error) {
      this.logger?.error('Failed to list resources from Neptune', { error });
      throw error;
    }
  }

  
  async createAnnotation(input: CreateAnnotationInternal): Promise<Annotation> {
    // The caller's id is the system of record's — never mint a fresh one
    // (the event-log id is what deletes and lookups arrive under).
    const annotation = buildAnnotation(input, new Date().toISOString());
    const props = encodeAnnotation(annotation);
    const targetSource = props.resourceId!;
    const bodySource = props.source;
    const entityTypes = getEntityTypes(input);

    try {
      // Create Annotation vertex — every property comes from the codec, so
      // a source-only target contributes no `selector` property at all.
      let vertex = this.g.addV('Annotation');
      for (const [key, value] of Object.entries(props)) {
        vertex = vertex.property(key, value);
      }

      const newVertex = await vertex.next();

      // Create edge from Annotation to Resource (BELONGS_TO)
      await this.g.V(newVertex.value)
        .addE('BELONGS_TO')
        .to(this.g.V().hasLabel('Resource').has('id', targetSource)) // Use full URI
        .next();

      // If it's a resolved reference, create edge to target resource (REFERENCES)
      if (bodySource) {
        await this.g.V(newVertex.value)
          .addE('REFERENCES')
          .to(this.g.V().hasLabel('Resource').has('id', bodySource)) // Use full URI
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

      this.logger?.info('Created annotation vertex in Neptune', { id: annotation.id });
      return annotation;
    } catch (error) {
      this.logger?.error('Failed to create annotation in Neptune', { error });
      throw error;
    }
  }
  
  async getAnnotation(id: AnnotationId): Promise<Annotation | null> {
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
      this.logger?.error('Failed to get annotation from Neptune', { error });
      throw error;
    }
  }
  
  async updateAnnotation(id: AnnotationId, updates: Partial<Annotation>): Promise<Annotation> {
    try {
      let traversal = this.g.V()
        .hasLabel('Annotation')
        .has('id', id);

      // Update target properties
      if (updates.target !== undefined && typeof updates.target !== 'string') {
        if (updates.target.selector !== undefined) {
          for (const [key, value] of Object.entries(encodeSelector(updates.target.selector))) {
            traversal = traversal.property(key, value);
          }
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
      this.logger?.error('Failed to update annotation in Neptune', { error });
      throw error;
    }
  }
  
  async deleteAnnotation(id: AnnotationId): Promise<void> {
    try {
      await this.g.V()
        .hasLabel('Annotation')
        .has('id', id)
        .drop()
        .iterate();

      this.logger?.info('Deleted annotation from Neptune', { id });
    } catch (error) {
      this.logger?.error('Failed to delete annotation from Neptune', { error });
      throw error;
    }
  }
  
  async listAnnotations(filter: { resourceId?: ResourceId; type?: AnnotationCategory }): Promise<{ annotations: Annotation[]; total: number }> {
    try {
      let traversal = this.g.V().hasLabel('Annotation');

      // Apply filters
      if (filter.resourceId) {
        traversal = traversal.has('resourceId', filter.resourceId);
      }

      if (filter.type) {
        traversal = traversal.has('type', storedAnnotationType(motivationForCategory(filter.type)));
      }

      const results = await traversal.elementMap().toList();
      const annotations = await this.fetchAnnotationsWithEntityTypes(results);

      return { annotations, total: annotations.length };
    } catch (error) {
      this.logger?.error('Failed to list annotations from Neptune', { error });
      throw error;
    }
  }
  
  
  async getHighlights(resourceId: ResourceId): Promise<Annotation[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Annotation')
        .has('resourceId', resourceId)
        .hasNot('resolvedResourceId')
        .elementMap()
        .toList();

      return await this.fetchAnnotationsWithEntityTypes(results);
    } catch (error) {
      this.logger?.error('Failed to get highlights from Neptune', { error });
      throw error;
    }
  }
  
  async resolveReference(annotationId: AnnotationId, source: ResourceId): Promise<Annotation> {
    try {
      // Get target resource name
      const targetDocResult = await this.g.V()
        .hasLabel('Resource')
        .has('id', source)
        .elementMap()
        .next();
      const targetDoc = targetDocResult.value ? vertexToResource(targetDocResult.value) : null;

      // Update the existing Annotation vertex
      const traversal = this.g.V()
        .hasLabel('Annotation')
        .has('id', annotationId)
        .property('source', source)
        .property('resolvedResourceName', targetDoc?.name)
        .property('resolvedAt', new Date().toISOString());

      const result = await traversal.elementMap().next();

      if (!result.value) {
        throw new Error('Annotation not found');
      }

      // Create REFERENCES edge to the resolved resource
      const annVertex = await this.g.V()
        .hasLabel('Annotation')
        .has('id', annotationId)
        .next();

      await this.g.V(annVertex.value)
        .addE('REFERENCES')
        .to(this.g.V().hasLabel('Resource').has('id', source))
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
      this.logger?.error('Failed to resolve reference in Neptune', { error });
      throw error;
    }
  }
  
  async getReferences(resourceId: ResourceId): Promise<Annotation[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Annotation')
        .has('resourceId', resourceId)
        .has('resolvedResourceId')
        .elementMap()
        .toList();

      return await this.fetchAnnotationsWithEntityTypes(results);
    } catch (error) {
      this.logger?.error('Failed to get references from Neptune', { error });
      throw error;
    }
  }
  
  async getEntityReferences(resourceId: ResourceId, entityTypes?: string[]): Promise<Annotation[]> {
    try {
      let traversal = this.g.V()
        .hasLabel('Annotation')
        .has('resourceId', resourceId)
        .has('resolvedResourceId')
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
      this.logger?.error('Failed to get entity references from Neptune', { error });
      throw error;
    }
  }
  
  async getResourceAnnotations(resourceId: ResourceId): Promise<Annotation[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Annotation')
        .has('resourceId', resourceId)
        .elementMap()
        .toList();

      return await this.fetchAnnotationsWithEntityTypes(results);
    } catch (error) {
      this.logger?.error('Failed to get resource annotations from Neptune', { error });
      throw error;
    }
  }
  
  async getResourceReferencedBy(resourceId: ResourceId, _motivation?: string): Promise<Annotation[]> {
    try {
      const results = await this.g.V()
        .hasLabel('Annotation')
        .has('resolvedResourceId', resourceId)
        .elementMap()
        .toList();

      return await this.fetchAnnotationsWithEntityTypes(results);
    } catch (error) {
      this.logger?.error('Failed to get resource referenced by from Neptune', { error });
      throw error;
    }
  }
  
  async getResourceConnections(resourceId: ResourceId): Promise<GraphConnection[]> {
    try {
      // Get all annotations from this resource that reference other resources
      const outgoingAnnotations = await this.g.V()
        .hasLabel('Annotation')
        .has('resourceId', resourceId)
        .has('source')
        .elementMap()
        .toList();

      // Get all annotations that reference this resource
      const incomingAnnotations = await this.g.V()
        .hasLabel('Annotation')
        .has('source', resourceId)
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

        // Get the target resource
        const targetDocResult = await this.g.V()
          .hasLabel('Resource')
          .has('id', targetDocId)
          .elementMap()
          .next();

        if (targetDocResult.value) {
          const targetDoc = vertexToResource(targetDocResult.value);
          const targetDocId = getResourceId(targetDoc);
          if (!targetDocId) continue;
          const existing = connectionsMap.get(targetDocId);
          if (existing) {
            existing.annotations.push(annotation);
          } else {
            connectionsMap.set(targetDocId, {
              targetResource: targetDoc,
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
      this.logger?.error('Failed to get resource connections from Neptune', { error });
      throw error;
    }
  }
  
  async findPath(fromResourceId: string, toResourceId: string, maxDepth: number = 5): Promise<GraphPath[]> {
    try {
      // Use Neptune's optimized path queries
      const results = await this.g.V()
        .hasLabel('Resource')
        .has('id', fromResourceId)
        .repeat(
          process.statics.both('REFERENCES')
            .simplePath()
        )
        .times(maxDepth)
        .emit()
        .has('id', toResourceId)
        .path()
        .by(process.statics.elementMap())
        .limit(10)
        .toList();
      
      const paths: GraphPath[] = [];
      
      for (const pathResult of results) {
        const resources: ResourceDescriptor[] = [];

        // Process path elements (alternating vertices and edges)
        for (let i = 0; i < pathResult.objects.length; i++) {
          const element = pathResult.objects[i];

          if (i % 2 === 0) {
            // Vertex (Resource)
            resources.push(vertexToResource(element));
          } else {
            // Edge - skip for now as we're using vertex-based annotations
            // We'd need to query for annotations between resources
          }
        }

        paths.push({ resources, annotations: [] });
      }
      
      return paths;
    } catch (error) {
      this.logger?.error('Failed to find paths in Neptune', { error });
      throw error;
    }
  }
  
  async getEntityTypeStats(): Promise<EntityTypeStats[]> {
    try {
      // Use Neptune's analytics capabilities
      const results = await this.g.V()
        .hasLabel('Resource')
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
      this.logger?.error('Failed to get entity type stats from Neptune', { error });
      throw error;
    }
  }
  
  async getStats(): Promise<{
    resourceCount: number;
    annotationCount: number;
    highlightCount: number;
    referenceCount: number;
    entityReferenceCount: number;
    entityTypes: Record<string, number>;
    contentTypes: Record<string, number>;
  }> {
    try {
      // Get resource count
      const docCountResult = await this.g.V()
        .hasLabel('Resource')
        .count()
        .next();
      const resourceCount = docCountResult.value || 0;
      
      // Get annotation count
      const selCountResult = await this.g.V()
        .hasLabel('Annotation')
        .count()
        .next();
      const annotationCount = selCountResult.value || 0;

      // Get highlight count (annotations without resolved resource)
      const highlightCountResult = await this.g.V()
        .hasLabel('Annotation')
        .hasNot('resolvedResourceId')
        .count()
        .next();
      const highlightCount = highlightCountResult.value || 0;

      // Get reference count (annotations with resolved resource)
      const referenceCountResult = await this.g.V()
        .hasLabel('Annotation')
        .has('resolvedResourceId')
        .count()
        .next();
      const referenceCount = referenceCountResult.value || 0;

      // Get entity reference count
      const entityRefCountResult = await this.g.V()
        .hasLabel('Annotation')
        .has('resolvedResourceId')
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
        .hasLabel('Resource')
        .groupCount()
        .by('contentType')
        .next();
      const contentTypes = contentTypeResult.value || {};
      
      return {
        resourceCount,
        annotationCount,
        highlightCount,
        referenceCount,
        entityReferenceCount,
        entityTypes,
        contentTypes,
      };
    } catch (error) {
      this.logger?.error('Failed to get stats from Neptune', { error });
      throw error;
    }
  }
  
  async batchCreateResources(resources: ResourceDescriptor[]): Promise<ResourceDescriptor[]> {
    const results: ResourceDescriptor[] = [];
    for (const resource of resources) {
      results.push(await this.createResource(resource));
    }
    return results;
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
      this.logger?.error('Failed to create annotations in Neptune', { error });
      throw error;
    }
  }


  async resolveReferences(inputs: { annotationId: AnnotationId; source: ResourceId }[]): Promise<Annotation[]> {
    const results: Annotation[] = [];

    try {
      for (const input of inputs) {
        const annotation = await this.resolveReference(input.annotationId, input.source);
        results.push(annotation);
      }

      return results;
    } catch (error) {
      this.logger?.error('Failed to resolve references in Neptune', { error });
      throw error;
    }
  }
  
  async detectAnnotations(_resourceId: ResourceId): Promise<Annotation[]> {
    // This would use AI/ML to detect annotations in a resource
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
      this.logger?.error('Failed to add entity type', { error });
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
      this.logger?.error('Failed to add entity types', { error });
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
      this.logger?.debug('No existing tag collections found, will initialize with defaults');
    }

    // Initialize with defaults if not present
    if (this.entityTypesCollection === null) {
      const { DEFAULT_ENTITY_TYPES } = await import('@semiont/ontology');
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
        this.logger?.error('Failed to initialize entity types', { error });
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
      this.logger?.info('Cleared all data from Neptune');
      // Reset tag collections
      this.entityTypesCollection = null;
    } catch (error) {
      this.logger?.error('Failed to clear Neptune database', { error });
      throw error;
    }
  }
}