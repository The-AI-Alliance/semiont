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
  components,
} from '@semiont/core';
import { getResourceId, getResourceEntityTypes, getTargetSource, resourceId as createResourceId } from '@semiont/core';
import { getEntityTypes } from '@semiont/ontology';
import type { KnowledgeBase } from './knowledge-base';

import type { Annotation } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';

// The unified knowledge-graph shape is the core/spec type (CONTEXT-UNIFICATION):
// resources AND annotations are nodes; edges are typed and directional. The
// hand-written local twins were deleted — this is the one canonical type definition.
type KnowledgeGraph = components['schemas']['KnowledgeGraph'];

/**
 * Flattened neighborhood views derived from a `KnowledgeGraph` (CONTEXT-UNIFICATION P3, Q1=A).
 * One derivation, shared by the annotation producer's `inferredRelationshipSummary` and the
 * matcher (P4). It reports what the graph holds — and the graph is a projection of the event log
 * (the system of record), read here because it is the queryable projection at gather time.
 */
export interface GraphViews {
  connections: { resourceId: string; resourceName: string; entityTypes: string[]; bidirectional: boolean }[];
  citedBy: { resourceId: string; resourceName: string }[];
  citedByCount: number;
  siblingEntityTypes: string[];
}

export class GraphContext {
  /**
   * Get all resources referencing this resource (backlinks)
   * Requires graph traversal - must use graph database
   */
  static async getBacklinks(resourceId: ResourceId, kb: KnowledgeBase): Promise<Annotation[]> {
    return kb.graph.getResourceReferencedBy(resourceId);
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
    return kb.graph.findPath(fromResourceId, toResourceId, maxDepth);
  }

  /**
   * Get resource connections (graph edges)
   * Requires graph traversal - must use graph database
   */
  static async getResourceConnections(resourceId: ResourceId, kb: KnowledgeBase): Promise<GraphConnection[]> {
    return kb.graph.getResourceConnections(resourceId);
  }

  /**
   * Search resources by name (cross-resource query)
   * Requires full-text search - must use graph database
   */
  static async searchResources(query: string, kb: KnowledgeBase, limit?: number): Promise<ResourceDescriptor[]> {
    return kb.graph.searchResources(query, limit);
  }

  /**
   * Build the unified knowledge graph for a resource's neighborhood:
   * resources AND annotations as typed nodes, typed/directional edges.
   *
   * This is the single graph builder (CONTEXT-UNIFICATION D3) — both the
   * matcher (ranking) and the resource/viz path consume it. The flattened
   * signals the matcher reads today (`connections`, `citedBy`/count,
   * `siblingEntityTypes`, `bidirectional`) are all derivable from this:
   *  - peer connections → resource nodes + main→peer edges carrying `bidirectional`
   *  - inbound citations → citing-resource nodes + `citation` edges (citing→main),
   *    so citedByCount = inbound citation-edge count
   *  - annotations on the resource → `annotation` nodes + `annotation-of` edges,
   *    so siblingEntityTypes = union of those nodes' entityTypes
   */
  static async buildKnowledgeGraph(
    resourceId: ResourceId,
    kb: KnowledgeBase,
  ): Promise<KnowledgeGraph> {
    const mainDoc = await kb.graph.getResource(resourceId);
    if (!mainDoc) {
      throw new Error('Resource not found');
    }
    // Deterministic main-node id so both consumers (deriveViews ranking, the resource/viz
    // related-node filter) line up without re-deriving it from a different projection.
    const mainId = String(resourceId);

    const [connections, referencedBy, annotations] = await Promise.all([
      kb.graph.getResourceConnections(resourceId),
      kb.graph.getResourceReferencedBy(resourceId),
      kb.graph.getResourceAnnotations(resourceId),
    ]);

    const nodes: KnowledgeGraph['nodes'] = [];
    const edges: KnowledgeGraph['edges'] = [];
    const seen = new Set<string>();

    const addResourceNode = (id: string | undefined, label: string, entityTypes: string[]): void => {
      if (!id || seen.has(id)) return;
      nodes.push({ id, type: 'resource', label, entityTypes });
      seen.add(id);
    };

    // Main resource
    addResourceNode(mainId, mainDoc.name, getResourceEntityTypes(mainDoc));

    // Peer connections → resource nodes + directional/bidirectional edges.
    // Full neighborhood — capping is a view concern, applied by the resource/viz consumer (Q2=C).
    for (const conn of connections) {
      const peerId = getResourceId(conn.targetResource);
      if (!peerId) continue;
      addResourceNode(peerId, conn.targetResource.name, getResourceEntityTypes(conn.targetResource));
      if (mainId) {
        edges.push({ source: mainId, target: peerId, type: conn.relationshipType || 'link', bidirectional: conn.bidirectional });
      }
    }

    // Inbound citations → citing-resource nodes + `citation` edges (citing → main)
    const citedSeen = new Set<string>();
    for (const ann of referencedBy) {
      const source = getTargetSource(ann.target);
      if (!source || source === String(resourceId) || citedSeen.has(source)) continue;
      citedSeen.add(source);
      const view = await kb.views.get(createResourceId(source));
      addResourceNode(source, view?.resource?.name ?? source, view?.resource ? getResourceEntityTypes(view.resource) : []);
      if (mainId) {
        edges.push({ source, target: mainId, type: 'citation' });
      }
    }

    // Annotations on this resource → annotation nodes + `annotation-of` edges
    for (const ann of annotations) {
      if (!ann.id || seen.has(ann.id)) continue;
      nodes.push({ id: ann.id, type: 'annotation', label: ann.motivation ?? 'annotation', entityTypes: getEntityTypes(ann) });
      seen.add(ann.id);
      if (mainId) {
        edges.push({ source: ann.id, target: mainId, type: 'annotation-of' });
      }
    }

    return { nodes, edges };
  }

  /**
   * Derive the flattened views (connections / citedBy / siblings) from a `KnowledgeGraph`
   * (CONTEXT-UNIFICATION P3, Q1=A). Reports the graph as-is — Option A: missing-view citers are
   * kept (the citation edge reflects a real reference event), and the only filter is excluding the
   * focal annotation from siblings (an annotation isn't its own sibling). Peer connections are
   * edges out of `mainResourceId`; citations and `annotation-of` edges point INTO it.
   */
  static deriveViews(
    graph: KnowledgeGraph,
    mainResourceId: string,
    focalAnnotationId?: string,
  ): GraphViews {
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));

    const connections: GraphViews['connections'] = [];
    const citedBy: GraphViews['citedBy'] = [];
    for (const edge of graph.edges) {
      if (edge.type === 'citation') {
        if (edge.target !== mainResourceId) continue;
        const node = nodeById.get(edge.source);
        citedBy.push({ resourceId: edge.source, resourceName: node?.label ?? edge.source });
      } else if (edge.source === mainResourceId) {
        const node = nodeById.get(edge.target);
        connections.push({
          resourceId: edge.target,
          resourceName: node?.label ?? edge.target,
          entityTypes: node?.entityTypes ?? [],
          bidirectional: edge.bidirectional ?? false,
        });
      }
    }

    const siblingEntityTypes = new Set<string>();
    for (const node of graph.nodes) {
      if (node.type === 'annotation' && node.id !== focalAnnotationId) {
        for (const et of node.entityTypes ?? []) siblingEntityTypes.add(et);
      }
    }

    return {
      connections,
      citedBy,
      citedByCount: citedBy.length,
      siblingEntityTypes: Array.from(siblingEntityTypes),
    };
  }
}
