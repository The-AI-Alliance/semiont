// Factory for creating graph database instances based on configuration

import { GraphDatabase } from './interface';
import { NeptuneGraphDatabase } from './implementations/neptune';
import { Neo4jGraphDatabase } from './implementations/neo4j';
import { JanusGraphDatabase } from './implementations/janusgraph';
import { getGraphConfig } from '../config/environment-loader';

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
    // Load config from environment JSON file or environment variables
    const graphConfig = getGraphConfig();
    
    const config: GraphDatabaseConfig = {
      type: graphConfig.type,
    };
    
    // Apply configuration based on type
    if (graphConfig.type === 'janusgraph') {
      if (graphConfig.host) {
        config.janusHost = graphConfig.host;
      }
      if (graphConfig.port) {
        config.janusPort = graphConfig.port;
      }
      if (graphConfig.storage) {
        config.janusStorageBackend = graphConfig.storage as any;
      }
      if (graphConfig.index && graphConfig.index !== 'none') {
        config.janusIndexBackend = graphConfig.index as any;
      }
    } else if (graphConfig.type === 'neptune') {
      // Neptune will discover its own endpoint using AWS SDK
      // Only pass the port from config
      if (graphConfig.port) {
        config.neptunePort = graphConfig.port;
      }
      // Region from AWS_REGION environment variable (needed for AWS SDK)
      const region = process.env.AWS_REGION;
      if (region) {
        config.neptuneRegion = region;
      }
    }
    
    // Neo4j config  
    if (process.env.NEO4J_URI) config.neo4jUri = process.env.NEO4J_URI;
    if (process.env.NEO4J_USERNAME) config.neo4jUsername = process.env.NEO4J_USERNAME;
    if (process.env.NEO4J_PASSWORD) config.neo4jPassword = process.env.NEO4J_PASSWORD;
    
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