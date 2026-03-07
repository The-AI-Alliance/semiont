/**
 * Graph Context
 *
 * Provides graph database operations for resources and annotations.
 * All methods require graph traversal - must use graph database.
 */

import { getGraphDatabase } from '@semiont/graph';
import { resourceIdToURI } from '@semiont/core';
import type {
  ResourceId,
  EnvironmentConfig,
  GraphConnection,
  GraphPath,
} from '@semiont/core';
import type { components } from '@semiont/core';
import { getResourceId, getResourceEntityTypes } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  metadata: { entityTypes: string[] };
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  metadata: Record<string, unknown>;
}

export interface GraphRepresentation {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export class GraphContext {
  /**
   * Get all resources referencing this resource (backlinks)
   * Requires graph traversal - must use graph database
   */
  static async getBacklinks(resourceId: ResourceId, config: EnvironmentConfig): Promise<Annotation[]> {
    const graphDb = await getGraphDatabase(config);
    const resourceUri = resourceIdToURI(resourceId, config.services.backend!.publicURL);
    return await graphDb.getResourceReferencedBy(resourceUri);
  }

  /**
   * Find shortest path between two resources
   * Requires graph traversal - must use graph database
   */
  static async findPath(
    fromResourceId: ResourceId,
    toResourceId: ResourceId,
    config: EnvironmentConfig,
    maxDepth?: number
  ): Promise<GraphPath[]> {
    const graphDb = await getGraphDatabase(config);
    return await graphDb.findPath(fromResourceId, toResourceId, maxDepth);
  }

  /**
   * Get resource connections (graph edges)
   * Requires graph traversal - must use graph database
   */
  static async getResourceConnections(resourceId: ResourceId, config: EnvironmentConfig): Promise<GraphConnection[]> {
    const graphDb = await getGraphDatabase(config);
    return await graphDb.getResourceConnections(resourceId);
  }

  /**
   * Search resources by name (cross-resource query)
   * Requires full-text search - must use graph database
   */
  static async searchResources(query: string, config: EnvironmentConfig, limit?: number): Promise<ResourceDescriptor[]> {
    const graphDb = await getGraphDatabase(config);
    return await graphDb.searchResources(query, limit);
  }

  /**
   * Build graph representation with nodes and edges for a resource and its connections
   * Retrieves connections from graph and builds visualization-ready structure
   */
  static async buildGraphRepresentation(
    resourceId: ResourceId,
    maxRelated: number,
    config: EnvironmentConfig
  ): Promise<GraphRepresentation> {
    const graphDb = await getGraphDatabase(config);
    const publicURL = config.services.backend!.publicURL;
    const resourceUri = resourceIdToURI(resourceId, publicURL);

    // Get main resource
    const mainDoc = await graphDb.getResource(resourceUri);
    if (!mainDoc) {
      throw new Error('Resource not found');
    }

    // Get connections
    const connections = await graphDb.getResourceConnections(resourceId);
    const relatedDocs = connections.map(conn => conn.targetResource).slice(0, maxRelated - 1);

    // Build nodes
    const nodes = [
      {
        id: getResourceId(mainDoc),
        type: 'resource',
        label: mainDoc.name,
        metadata: { entityTypes: getResourceEntityTypes(mainDoc) },
      },
      ...relatedDocs.map(doc => ({
        id: getResourceId(doc),
        type: 'resource',
        label: doc.name,
        metadata: { entityTypes: getResourceEntityTypes(doc) },
      })),
    ].filter(node => node.id !== undefined) as GraphNode[];

    // Build edges
    const edges = connections
      .slice(0, maxRelated - 1)
      .map(conn => ({
        source: resourceId,
        target: getResourceId(conn.targetResource),
        type: conn.relationshipType || 'link',
        metadata: {},
      }))
      .filter(edge => edge.target !== undefined) as GraphEdge[];

    return { nodes, edges };
  }
}
