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
    connections: {
        resourceId: string;
        resourceName: string;
        entityTypes: string[];
        bidirectional: boolean;
    }[];
    citedBy: {
        resourceId: string;
        resourceName: string;
    }[];
    citedByCount: number;
    siblingEntityTypes: string[];
}
export declare function deriveViews(graph: KnowledgeGraph, mainResourceId: string, focalAnnotationId?: string): GraphViews;
export {};
