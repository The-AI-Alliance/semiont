/**
 * Knowledge-graph view derivation (CONTEXT-UNIFICATION P3, Q1=A).
 *
 * A pure function over the core `KnowledgeGraph` type, so both `@semiont/make-meaning` (the matcher)
 * and `@semiont/jobs` (the generation prompt builder) can share one derivation. `buildKnowledgeGraph`
 * — which queries the graph DB — stays in make-meaning; this only transforms an already-built graph.
 *
 * Reports the graph as-is (Option A): missing-view citers are kept (the citing annotation reflects a
 * real reference event; its resource label falls back to the raw id). A citation is its linking
 * ANNOTATION: an annotation node with `annotation-of` → the citing resource and `cites` → the focal
 * resource — so citedBy resolves through that pair, deduped per citing resource (several citations
 * from one document are one citer). Siblings are annotations ON the focal resource
 * (`annotation-of` → main), excluding the focal annotation — an annotation isn't its own sibling,
 * and a CITING annotation lives on another resource, so it never was one. Peer connections are
 * edges out of `mainResourceId`; derivation is structural (endpoints), never a match on the
 * free-form relationshipType. The graph is a projection of the event log (the system of record),
 * read here because it is the queryable projection at gather time.
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
  // annotation id → the resource it lives on. Both derivations resolve through
  // this, which is what keeps them structural: a peer connection whose
  // relationshipType happens to be named 'cites' has no annotation-of entry.
  const annotationOf = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.type === 'annotation-of') annotationOf.set(edge.source, edge.target);
  }

  const connections: GraphViews['connections'] = [];
  const citedBy: GraphViews['citedBy'] = [];
  const citingSeen = new Set<string>();
  for (const edge of graph.edges) {
    const citingResource = edge.type === 'cites' && edge.target === mainResourceId
      ? annotationOf.get(edge.source)
      : undefined;
    if (citingResource !== undefined) {
      if (citingSeen.has(citingResource)) continue;
      citingSeen.add(citingResource);
      const node = nodeById.get(citingResource);
      citedBy.push({ resourceId: citingResource, resourceName: node?.label ?? citingResource });
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
    if (node.type === 'annotation' && node.id !== focalAnnotationId && annotationOf.get(node.id) === mainResourceId) {
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
