/**
 * Knowledge-graph view derivation (CONTEXT-UNIFICATION P3, Q1=A).
 *
 * A pure function over the core `KnowledgeGraph` type, so both `@semiont/make-meaning` (the matcher)
 * and `@semiont/jobs` (the generation prompt builder) can share one derivation. `buildKnowledgeGraph`
 * — which queries the graph DB — stays in make-meaning; this only transforms an already-built graph.
 *
 * Reports the graph as-is (Option A): missing-view citers are kept (the citation edge reflects a real
 * reference event); the only filter is excluding the focal annotation from siblings (an annotation
 * isn't its own sibling). Peer connections are edges out of `mainResourceId`; citations and
 * `annotation-of` edges point INTO it. The graph is a projection of the event log (the system of
 * record), read here because it is the queryable projection at gather time.
 */
import type { components } from './types';

type KnowledgeGraph = components['schemas']['KnowledgeGraph'];

export interface GraphViews {
  connections: { resourceId: string; resourceName: string; entityTypes: string[]; bidirectional: boolean }[];
  citedBy: { resourceId: string; resourceName: string }[];
  citedByCount: number;
  siblingEntityTypes: string[];
}

export function deriveViews(
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
