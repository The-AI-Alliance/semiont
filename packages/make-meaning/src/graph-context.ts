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

export class GraphContext {
  /**
   * Backoff schedule for the projection-lag grace in `buildKnowledgeGraph`
   * (GRAPH-PROJECTION-SYNC P1). Total wait is bounded at 375 ms — the Weaver
   * applies in tens of milliseconds when merely lagging; anything slower is
   * treated as a real miss.
   */
  private static readonly PROJECTION_LAG_BACKOFF_MS = [25, 50, 100, 200];

  /**
   * Bounded wait for the applied-offset barrier (GRAPH-PROJECTION-SYNC P2).
   * The Weaver applies in tens of milliseconds when merely lagging; a
   * barrier that hasn't woken in 500 ms means signals have stalled and the
   * poll floor above owns the remainder.
   */
  private static readonly PROJECTION_BARRIER_TIMEOUT_MS = 500;

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
    // Read-your-writes grace for the graph projection: the view materializer
    // applies on the append path, the Weaver lags behind it (see
    // .plans/bugs/gather-resource-races-graph-projection.md). "Present in the
    // view, absent in the graph" precisely identifies projection lag; a
    // resource the view doesn't know is genuinely unknown and throws on the
    // first read.
    let mainDoc = await kb.graph.getResource(resourceId);
    if (!mainDoc) {
      const view = await kb.views.get(resourceId);
      if (view) {
        // Applied-offset barrier first (P2, D2 = push): an event-driven wake
        // at the moment the Weaver reports parity with the view's sequence.
        // Views without a stamp (written pre-stamp) cannot name a parity
        // target and skip straight to the poll floor.
        if (view.lastSequence !== undefined) {
          try {
            await kb.weaveProgress.whenApplied(
              String(resourceId),
              view.lastSequence,
              GraphContext.PROJECTION_BARRIER_TIMEOUT_MS,
            );
            mainDoc = await kb.graph.getResource(resourceId);
          } catch {
            // Barrier timed out — signals stalled; the poll floor owns it.
          }
        }
        // Bounded-poll floor (P1): the fallback when the barrier cannot
        // engage or its signals stall.
        if (!mainDoc) {
          for (const delayMs of GraphContext.PROJECTION_LAG_BACKOFF_MS) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            mainDoc = await kb.graph.getResource(resourceId);
            if (mainDoc) break;
          }
        }
      }
    }
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
      edges.push({ source: mainId, target: peerId, type: conn.relationshipType || 'link', bidirectional: conn.bidirectional });
    }

    // Inbound citations → citing-resource nodes + `citation` edges (citing → main)
    const citedSeen = new Set<string>();
    for (const ann of referencedBy) {
      const source = getTargetSource(ann.target);
      if (!source || source === String(resourceId) || citedSeen.has(source)) continue;
      citedSeen.add(source);
      const view = await kb.views.get(createResourceId(source));
      addResourceNode(source, view?.resource?.name ?? source, view?.resource ? getResourceEntityTypes(view.resource) : []);
      edges.push({ source, target: mainId, type: 'citation' });
    }

    // Annotations on this resource → annotation nodes + `annotation-of` edges
    for (const ann of annotations) {
      if (!ann.id || seen.has(ann.id)) continue;
      nodes.push({ id: ann.id, type: 'annotation', label: ann.motivation ?? 'annotation', entityTypes: getEntityTypes(ann) });
      seen.add(ann.id);
      edges.push({ source: ann.id, target: mainId, type: 'annotation-of' });
    }

    return { nodes, edges };
  }
}
