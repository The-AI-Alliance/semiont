/**
 * Graph Context
 *
 * Provides graph database operations for resources and annotations.
 * All methods require graph traversal - must use graph database.
 */

import type {
  ResourceId,
  GraphConnection,
  GraphPath,
} from '@semiont/core';
import { getResourceId, getResourceEntityTypes } from '@semiont/core';
import type { KnowledgeBase } from './knowledge-base';

import type { Annotation } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';

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
  static async getBacklinks(resourceId: ResourceId, kb: KnowledgeBase): Promise<Annotation[]> {
    return await kb.graph.getResourceReferencedBy(resourceId);
  }

  /**
   * Find shortest path between two resources
   * Requires graph traversal - must use graph database
   */
  static async findPath(
    fromResourceId: ResourceId,
    toResourceId: ResourceId,
    kb: KnowledgeBase,
    maxDepth?: number
  ): Promise<GraphPath[]> {
    return await kb.graph.findPath(fromResourceId, toResourceId, maxDepth);
  }

  /**
   * Get resource connections (graph edges)
   * Requires graph traversal - must use graph database
   */
  static async getResourceConnections(resourceId: ResourceId, kb: KnowledgeBase): Promise<GraphConnection[]> {
    return await kb.graph.getResourceConnections(resourceId);
  }

  /**
   * Search resources by name (cross-resource query)
   * Requires full-text search - must use graph database
   */
  static async searchResources(query: string, kb: KnowledgeBase, limit?: number): Promise<ResourceDescriptor[]> {
    return await kb.graph.searchResources(query, limit);
  }

  /**
   * Build graph representation with nodes and edges for a resource and its connections
   * Retrieves connections from graph and builds visualization-ready structure
   */
  static async buildGraphRepresentation(
    resourceId: ResourceId,
    maxRelated: number,
    kb: KnowledgeBase,
  ): Promise<GraphRepresentation> {
    // Get main resource
    const mainDoc = await kb.graph.getResource(resourceId);
    if (!mainDoc) {
      throw new Error('Resource not found');
    }

    // Get connections
    const connections = await kb.graph.getResourceConnections(resourceId);
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
