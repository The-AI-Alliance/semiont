// Factory for creating graph database instances based on configuration

import { GraphDatabase } from './interface';
import { NeptuneGraphDatabase } from './implementations/neptune';
import { Neo4jGraphDatabase } from './implementations/neo4j';
import { JanusGraphDatabase } from './implementations/janusgraph';
import { MemoryGraphDatabase } from './implementations/memorygraph';
import { getGraphConfig } from '../config/config';

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
  neo4jDatabase?: string;
  
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
      if (config.neo4jDatabase !== undefined) neo4jConfig.database = config.neo4jDatabase;
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
      return new MemoryGraphDatabase({});
      
    default:
      throw new Error(`Unsupported graph database type: ${config.type}`);
  }
}

// Helper function to evaluate environment variable placeholders
function evaluateEnvVar(value: string | undefined): string | undefined {
  if (!value) return undefined;

  // Replace ${VAR_NAME} with actual environment variable value
  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (!envValue) {
      throw new Error(`Environment variable ${varName} is not set. Referenced in configuration as ${match}`);
    }
    return envValue;
  });
}

export async function getGraphDatabase(): Promise<GraphDatabase> {
  if (!graphDatabaseInstance) {
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
      if (graphConfig.endpoint) {
        config.neptuneEndpoint = graphConfig.endpoint;
      }
      if (graphConfig.port) {
        config.neptunePort = graphConfig.port;
      }
      if (graphConfig.region) {
        config.neptuneRegion = graphConfig.region;
      }
    } else if (graphConfig.type === 'neo4j') {
      if (graphConfig.uri) {
        config.neo4jUri = evaluateEnvVar(graphConfig.uri);
      }
      if (graphConfig.username) {
        config.neo4jUsername = evaluateEnvVar(graphConfig.username);
      }
      if (graphConfig.password) {
        config.neo4jPassword = evaluateEnvVar(graphConfig.password);
      }
      if (graphConfig.database) {
        config.neo4jDatabase = evaluateEnvVar(graphConfig.database);
      }
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