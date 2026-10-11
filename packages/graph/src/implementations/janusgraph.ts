// JanusGraph implementation with real Gremlin connection

import { GraphDatabase } from '../interface';
import { queryResources } from '../resource-query';
import type { Logger } from '@semiont/core';
import { getBodySource, getResourceId } from '@semiont/core';
import type {
  AnnotationCategory,
  GraphConnection,
  EntityTypeStats,
  ResourceFilter,
  ResourceId,
  AnnotationId,
} from '@semiont/core';
import {
  decodeAnnotation,
  motivationForCategory,
  storedAnnotationType,
  type AnnotationProperties,
} from '../annotation-codec';
import { decodeResource, type ResourceProperties } from '../resource-codec';

import type { ResourceDescriptor } from '@semiont/core';
import type { Annotation } from '@semiont/core';

/** Helper to get property value from Gremlin vertex properties */
function getPropertyValue(props: any, key: string): any {
  if (!props[key]) return undefined;
  const prop = Array.isArray(props[key]) ? props[key][0] : props[key];
  return prop?.value || prop;
}

/**
 * Convert a JanusGraph vertex to an Annotation.
 *
 * Module-level so the cross-store conformance suite can run this store's
 * decode path with no live JanusGraph: everything past the flattening is the
 * shared codec's.
 */
export function vertexToAnnotation(vertex: any, entityTypes: string[] = []): Annotation {
  const props = vertex.properties || {};
  const normalized: AnnotationProperties = {};
  for (const key of Object.keys(props)) {
    const value = getPropertyValue(props, key);
    if (value === undefined || value === null) continue;
    normalized[key] = typeof value === 'string' ? value : String(value);
  }
  return decodeAnnotation(normalized, entityTypes);
}

export class JanusGraphDatabase implements GraphDatabase {
  private connected: boolean = false;
  private connection: any | null = null;
  private g: any | null = null;
  private logger?: Logger;

  constructor(
    private graphConfig: {
      host?: string;
      port?: number;
      storageBackend?: 'cassandra' | 'hbase' | 'berkeleydb';
      indexBackend?: 'elasticsearch' | 'solr' | 'lucene';
      logger?: Logger;
    },
  ) {
    this.logger = graphConfig.logger;
  }
  
  async connect(): Promise<void> {
    // Configuration must be provided via constructor
    const host = this.graphConfig.host;
    if (!host) {
      throw new Error('JanusGraph host is required: provide in config');
    }

    const port = this.graphConfig.port;
    if (!port) {
      throw new Error('JanusGraph port is required: provide in config');
    }

    this.logger?.info('Connecting to JanusGraph', { host, port });

    const gremlin = await import('gremlin');
    const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
    const traversal = gremlin.process.AnonymousTraversalSource.traversal;

    this.connection = new DriverRemoteConnection(
      `ws://${host}:${port}/gremlin`,
      {}
    );

    this.g = traversal().withRemote(this.connection);

    // Test the connection with a simple query
    await this.g.V().limit(1).toList();

    this.connected = true;
    this.logger?.info('Successfully connected to JanusGraph');

    // Initialize schema if needed
    await this.initializeSchema();
  }
  
  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
    }
    this.connected = false;
  }
  
  isConnected(): boolean {
    return this.connected;
  }
  
  private async initializeSchema(): Promise<void> {
    // Note: Schema management in JanusGraph typically requires direct access
    // to the management API, which isn't available through Gremlin.
    // In production, you'd run schema initialization scripts separately.
    this.logger?.debug('Schema initialization would happen here in production');
  }
  
  // Helper function to convert vertex to Resource
  /**
   * A vertex's properties, in the resource codec's names. Gremlin keeps a list
   * as a JSON string and hands a boolean back as either; what the properties
   * mean, and which a resource must have, is the codec's.
   */
  private vertexToResource(vertex: any): ResourceDescriptor {
    const props = vertex.properties || {};
    const value = (key: keyof ResourceProperties) => getPropertyValue(props, key);
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
  
  // Helper method to fetch annotations with their entity types
  private async fetchAnnotationsWithEntityTypes(annotationVertices: any[]): Promise<Annotation[]> {
    const annotations: Annotation[] = [];

    for (const vertex of annotationVertices) {
      const id = getPropertyValue(vertex.properties || {}, 'id');

      // Fetch entity types for this annotation
      const entityTypeVertices = await this.g!
        .V()
        .has('Annotation', 'id', id)
        .out('TAGGED_AS')
        .has('EntityType')
        .toList();

      const entityTypes = entityTypeVertices.map((v: any) =>
        getPropertyValue(v.properties || {}, 'name')
      ).filter(Boolean);

      annotations.push(vertexToAnnotation(vertex, entityTypes));
    }

    return annotations;
  }


  async getResource(id: ResourceId): Promise<ResourceDescriptor | null> {
    const vertices = await this.g!
      .V()
      .has('Resource', 'id', id)
      .toList();

    if (vertices.length === 0) {
      return null;
    }

    return this.vertexToResource(vertices[0] as any);
  }
  
  async listResources(filter: ResourceFilter): Promise<{ resources: ResourceDescriptor[]; total: number }> {
    // Note: filtering is done client-side after retrieval. In production,
    // JanusGraph supports server-side text predicates via Elasticsearch,
    // but composing OR across multiple text properties requires the
    // anonymous-traversal API; for a gateway that's not the production
    // target, JS post-filtering is simpler and adequate at our scale.
    const docs = await this.g!.V().hasLabel('Resource').toList();
    return queryResources(docs.map((v: any) => this.vertexToResource(v)), filter);
  }


  async getAnnotation(id: AnnotationId): Promise<Annotation | null> {
    const vertices = await this.g!
      .V()
      .has('Annotation', 'id', id)
      .toList();

    if (vertices.length === 0) {
      return null;
    }

    // Fetch entity types from TAGGED_AS relationships
    const entityTypeVertices = await this.g!
      .V()
      .has('Annotation', 'id', id)
      .out('TAGGED_AS')
      .has('EntityType')
      .toList();

    const entityTypes = entityTypeVertices.map((v: any) =>
      getPropertyValue(v.properties || {}, 'name')
    ).filter(Boolean);

    return vertexToAnnotation(vertices[0] as any, entityTypes);
  }
  
  private async listAnnotations(filter: { resourceId?: ResourceId; type?: AnnotationCategory }): Promise<{ annotations: Annotation[]; total: number }> {
    let traversalQuery = this.g!.V().hasLabel('Annotation');

    // Apply filters
    if (filter.resourceId) {
      traversalQuery = traversalQuery.has('resourceId', filter.resourceId);
    }

    if (filter.type) {
      traversalQuery = traversalQuery.has('type', storedAnnotationType(motivationForCategory(filter.type)));
    }

    const vertices = await traversalQuery.toList();
    const annotations = await this.fetchAnnotationsWithEntityTypes(vertices);

    return {
      annotations,
      total: annotations.length
    };
  }

  private async getReferences(resourceId: ResourceId): Promise<Annotation[]> {
    const { annotations } = await this.listAnnotations({
      resourceId,
      type: 'reference'
    });
    return annotations;
  }

  async getResourceAnnotations(resourceId: ResourceId): Promise<Annotation[]> {
    const { annotations } = await this.listAnnotations({ resourceId });
    return annotations;
  }

  async getResourceReferencedBy(resourceId: ResourceId, _motivation?: string): Promise<Annotation[]> {
    // Find annotations that reference this resource
    const vertices = await this.g!
      .V()
      .hasLabel('Annotation')
      .has('source', resourceId)
      .toList();

    return this.fetchAnnotationsWithEntityTypes(vertices);
  }
  
  async getResourceConnections(resourceId: ResourceId): Promise<GraphConnection[]> {
    const connections: GraphConnection[] = [];
    const refs = await this.getReferences(resourceId);

    for (const ref of refs) {
      // Extract source from body using helper
      const bodySource = getBodySource(ref.body);
      if (bodySource) {
        const targetDoc = await this.getResource(bodySource);
        if (targetDoc) {
          const targetId = getResourceId(targetDoc);
          const existing = connections.find(c => getResourceId(c.targetResource) === targetId);
          if (existing) {
            existing.annotations.push(ref);
          } else {
            connections.push({
              targetResource: targetDoc,
              annotations: [ref],
              relationshipType: undefined,
              bidirectional: false,
            });
          }
        }
      }
    }

    return connections;
  }
  
  async getEntityTypeStats(): Promise<EntityTypeStats[]> {
    const docs = await this.g!.V().hasLabel('Resource').toList();
    const resources = docs.map((v: any) => this.vertexToResource(v));

    const stats = new Map<string, number>();

    for (const doc of resources) {
      for (const type of doc.entityTypes || []) {
        stats.set(type, (stats.get(type) || 0) + 1);
      }
    }

    return Array.from(stats.entries()).map(([type, count]) => ({ type, count }));
  }
}