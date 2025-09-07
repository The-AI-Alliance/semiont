// Factory for creating graph database instances based on configuration

import { GraphDatabase } from './interface';
import { NeptuneGraphDatabase } from './implementations/neptune';
import { Neo4jGraphDatabase } from './implementations/neo4j';
import { JanusGraphDatabase } from './implementations/janusgraph';

export type GraphDatabaseType = 'neptune' | 'neo4j' | 'janusgraph' | 'memory';

export interface GraphDatabaseConfig {
  type: GraphDatabaseType;
  
  // Neptune config
  neptuneEndpoint?: string;
  neptunePort?: number;
  neptuneRegion?: string;
  
  // Neo4j config
  neo4jUri?: string;
  neo4jUsername?: string;
  neo4jPassword?: string;
  
  // JanusGraph config
  janusHost?: string;
  janusPort?: number;
  janusStorageBackend?: 'cassandra' | 'hbase' | 'berkeleydb';
  janusIndexBackend?: 'elasticsearch' | 'solr' | 'lucene';
}

// Singleton instance
let graphDatabaseInstance: GraphDatabase | null = null;

export function createGraphDatabase(config: GraphDatabaseConfig): GraphDatabase {
  switch (config.type) {
    case 'neptune': {
      const neptuneConfig: any = {};
      if (config.neptuneEndpoint !== undefined) neptuneConfig.endpoint = config.neptuneEndpoint;
      if (config.neptunePort !== undefined) neptuneConfig.port = config.neptunePort;
      if (config.neptuneRegion !== undefined) neptuneConfig.region = config.neptuneRegion;
      return new NeptuneGraphDatabase(neptuneConfig);
    }
      
    case 'neo4j': {
      const neo4jConfig: any = {};
      if (config.neo4jUri !== undefined) neo4jConfig.uri = config.neo4jUri;
      if (config.neo4jUsername !== undefined) neo4jConfig.username = config.neo4jUsername;
      if (config.neo4jPassword !== undefined) neo4jConfig.password = config.neo4jPassword;
      return new Neo4jGraphDatabase(neo4jConfig);
    }
      
    case 'janusgraph': {
      const janusConfig: any = {};
      if (config.janusHost !== undefined) janusConfig.host = config.janusHost;
      if (config.janusPort !== undefined) janusConfig.port = config.janusPort;
      if (config.janusStorageBackend !== undefined) janusConfig.storageBackend = config.janusStorageBackend;
      if (config.janusIndexBackend !== undefined) janusConfig.indexBackend = config.janusIndexBackend;
      return new JanusGraphDatabase(janusConfig);
    }
      
    case 'memory':
      // Use any implementation with in-memory storage (they're all stubs for now)
      return new NeptuneGraphDatabase({});
      
    default:
      throw new Error(`Unsupported graph database type: ${config.type}`);
  }
}

export async function getGraphDatabase(): Promise<GraphDatabase> {
  if (!graphDatabaseInstance) {
    // Load config from environment
    const config: GraphDatabaseConfig = {
      type: (process.env.GRAPH_DB_TYPE as GraphDatabaseType) || 'memory',
    };
    
    // Neptune config
    if (process.env.NEPTUNE_ENDPOINT) config.neptuneEndpoint = process.env.NEPTUNE_ENDPOINT;
    if (process.env.NEPTUNE_PORT) config.neptunePort = parseInt(process.env.NEPTUNE_PORT);
    const region = process.env.NEPTUNE_REGION || process.env.AWS_REGION;
    if (region) {
      config.neptuneRegion = region;
    }
    
    // Neo4j config  
    if (process.env.NEO4J_URI) config.neo4jUri = process.env.NEO4J_URI;
    if (process.env.NEO4J_USERNAME) config.neo4jUsername = process.env.NEO4J_USERNAME;
    if (process.env.NEO4J_PASSWORD) config.neo4jPassword = process.env.NEO4J_PASSWORD;
    
    // JanusGraph config
    if (process.env.JANUSGRAPH_HOST) config.janusHost = process.env.JANUSGRAPH_HOST;
    if (process.env.JANUSGRAPH_PORT) config.janusPort = parseInt(process.env.JANUSGRAPH_PORT);
    if (process.env.JANUSGRAPH_STORAGE) {
      config.janusStorageBackend = process.env.JANUSGRAPH_STORAGE as any;
    }
    if (process.env.JANUSGRAPH_INDEX) {
      config.janusIndexBackend = process.env.JANUSGRAPH_INDEX as any;
    }
    
    graphDatabaseInstance = createGraphDatabase(config);
    await graphDatabaseInstance.connect();
  }
  
  if (!graphDatabaseInstance.isConnected()) {
    await graphDatabaseInstance.connect();
  }
  
  return graphDatabaseInstance;
}

export async function closeGraphDatabase(): Promise<void> {
  if (graphDatabaseInstance) {
    await graphDatabaseInstance.disconnect();
    graphDatabaseInstance = null;
  }
}