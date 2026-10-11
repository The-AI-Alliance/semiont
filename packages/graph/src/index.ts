/**
 * @semiont/graph
 *
 * The graph, as a reader of it reads it. The one writer of the graph is the
 * Weaver, which writes through `semiont_graph` (packages/graph-python).
 *
 * Provides:
 * - GraphDatabase interface
 * - Singleton factory pattern for runtime selection
 * - 3 stores a configuration selects (Neo4j, Neptune, JanusGraph), and one a
 *   test makes with what it holds (MemoryGraph)
 */

// Graph Database interface
export type { GraphDatabase } from './interface';

// Factory pattern (singleton)
export { getGraphDatabase } from './factory';

// Implementations (for direct use if needed)
export { intendedGraphAnnotation } from './annotation-codec';
export { Neo4jGraphDatabase } from './implementations/neo4j';
export { NeptuneGraphDatabase } from './implementations/neptune';
export { JanusGraphDatabase } from './implementations/janusgraph';
export { MemoryGraphDatabase } from './implementations/memorygraph';
