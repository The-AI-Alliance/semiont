// AWS Neptune implementation of GraphDatabase interface
// Uses Gremlin for graph traversal

import { GraphDatabase } from '../interface';
import { queryResources } from '../resource-query';
import type { Logger } from '@semiont/core';
import {
  decodeAnnotation,
  type AnnotationProperties,
} from '../annotation-codec';
import { decodeResource, type ResourceProperties } from '../resource-codec';
import type {
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  ResourceFilter,
  ResourceId,
  AnnotationId,
} from '@semiont/core';
import { getBodySource, getTargetSource, getResourceId } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';
import type { Annotation } from '@semiont/core';

// Dynamic imports for AWS SDK and Gremlin
let NeptuneClient: any;
let DescribeDBClustersCommand: any;
let gremlin: any;
let process: any;

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
  }
}

// Helper function to convert Neptune vertex to ResourceDescriptor
/**
 * A vertex's properties, in the resource codec's names. Gremlin keeps a list
 * as a JSON string and hands a boolean back as either; what the properties
 * mean, and which a resource must have, is the codec's.
 */
function vertexToResource(vertex: any): ResourceDescriptor {
  const props = vertex.properties || vertex;

  // Handle different property formats from Neptune
  const value = (key: keyof ResourceProperties) => {
    const prop = props[key];
    if (prop === undefined || prop === null) return undefined;
    if (Array.isArray(prop)) {
      if (prop.length === 0) return undefined;
      return prop[0].value !== undefined ? prop[0].value : prop[0];
    }
    return prop.value !== undefined ? prop.value : prop;
  };

  const entityTypes = value('entityTypes');
  const archived = value('archived');
  return decodeResource({
    id: value('id'),
    name: value('name'),
    entityTypes: typeof entityTypes === 'string' ? JSON.parse(entityTypes) : entityTypes,
    format: value('format'),
    archived: archived === undefined ? undefined : archived === true || archived === 'true',
    created: value('created'),
    creator: value('creator'),
    contentChecksum: value('contentChecksum'),
    storageUri: value('storageUri'),
  });
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
   * deployment targets. If either becomes one at scale, the fix is a
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
  
  async findPath(fromResourceId: ResourceId, toResourceId: ResourceId, maxDepth: number = 5): Promise<GraphPath[]> {
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
            // Edge - skipped: annotations are vertices, so filling them in
            // would need a query for annotations between resources
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
        .by('format')
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
}