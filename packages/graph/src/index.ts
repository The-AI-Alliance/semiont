/**
 * @semiont/graph
 *
 * Graph database abstraction with multiple implementations
 *
 * Provides:
 * - GraphDatabase interface with 28 methods
 * - Singleton factory pattern for runtime selection
 * - 4 implementations: Neo4j, Neptune, JanusGraph, MemoryGraph
 */

// Graph Database interface
export type { GraphDatabase } from './interface';

// Factory pattern (singleton)
export { getGraphDatabase, createGraphDatabase, closeGraphDatabase } from './factory';

// Implementations (for direct use if needed)
export { Neo4jGraphDatabase } from './implementations/neo4j';
export { NeptuneGraphDatabase } from './implementations/neptune';
export { JanusGraphDatabase } from './implementations/janusgraph';
export { MemoryGraphDatabase } from './implementations/memorygraph';
