// The graph database a knowledge base's configuration names: one connection
// for the process.

import { GraphDatabase } from './interface';
import { NeptuneGraphDatabase } from './implementations/neptune';
import { Neo4jGraphDatabase } from './implementations/neo4j';
import { JanusGraphDatabase } from './implementations/janusgraph';
import type { GraphServiceConfig } from '@semiont/core';

let graphDatabaseInstance: GraphDatabase | null = null;

/**
 * The store a configuration names, given what the configuration says of it.
 * A store says what it was not given when it connects.
 *
 * `memory` is a graph a test makes, with what it holds (MemoryGraphDatabase).
 * No configuration yields one: it could not be shared with the Weaver that
 * writes the graph, and the Weaver and the Librarian each refuse it.
 */
function storeOf(config: GraphServiceConfig): GraphDatabase {
  switch (config.type) {
    case 'neptune':
      return new NeptuneGraphDatabase({ endpoint: config.endpoint, port: config.port, region: config.region });
    case 'neo4j':
      return new Neo4jGraphDatabase({ uri: config.uri, username: config.username, password: config.password, database: config.database });
    case 'janusgraph':
      return new JanusGraphDatabase({ host: config.host, port: config.port });
    default:
      throw new Error(`Unsupported graph database type: ${config.type}`);
  }
}

export async function getGraphDatabase(graphConfig: GraphServiceConfig): Promise<GraphDatabase> {
  if (!graphDatabaseInstance) {
    graphDatabaseInstance = storeOf(graphConfig);
  }

  if (!graphDatabaseInstance.isConnected()) {
    await graphDatabaseInstance.connect();
  }

  return graphDatabaseInstance;
}
