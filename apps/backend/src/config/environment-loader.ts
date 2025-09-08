/**
 * Environment configuration loader for backend
 * Reads configuration from environment JSON files
 */

import * as fs from 'fs';
import * as path from 'path';

interface GraphServiceConfig {
  name?: string;
  port?: number;
  host?: string;
  storage?: 'cassandra' | 'berkeleydb';
  index?: 'elasticsearch' | 'none';
  [key: string]: any;
}

interface EnvironmentConfig {
  services?: {
    graph?: GraphServiceConfig;
    janusgraph?: GraphServiceConfig;
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * Load environment configuration from JSON file
 */
export function loadEnvironmentConfig(): EnvironmentConfig | null {
  try {
    // Get environment name from SEMIONT_ENV or NODE_ENV
    const envName = process.env.SEMIONT_ENV || process.env.NODE_ENV || 'local';
    
    // Try to find the environment file
    const possiblePaths = [
      // In production, might be in /app
      path.join('/app', 'templates', 'environments', `${envName}.json`),
      // In development, look for CLI templates
      path.join(process.cwd(), '..', 'cli', 'templates', 'environments', `${envName}.json`),
      // Alternative development path
      path.join(process.cwd(), '..', '..', 'apps', 'cli', 'templates', 'environments', `${envName}.json`),
      // Check project root
      path.join(process.cwd(), 'environments', `${envName}.json`),
    ];
    
    for (const envPath of possiblePaths) {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        return JSON.parse(content);
      }
    }
    
    // No environment file found
    return null;
  } catch (error) {
    console.warn('Failed to load environment config:', error);
    return null;
  }
}

/**
 * Get graph database configuration from environment
 */
export function getGraphConfig(): {
  type: 'janusgraph' | 'neptune' | 'neo4j' | 'memory';
  host?: string;
  port?: number;
  storage?: string;
  index?: string;
} {
  // First try to load from environment JSON
  const envConfig = loadEnvironmentConfig();
  
  if (envConfig?.services?.graph || envConfig?.services?.janusgraph) {
    const graphService = envConfig.services.graph || envConfig.services.janusgraph;
    
    if (graphService) {
      // Determine graph type from service name or default to janusgraph
      const graphType = graphService.name || 'janusgraph';
      
      const result: {
        type: 'janusgraph' | 'neptune' | 'neo4j' | 'memory';
        host?: string;
        port?: number;
        storage?: string;
        index?: string;
      } = {
        type: graphType as any,
        host: graphService.host || 'localhost',
        port: graphService.port || 8182
      };
      
      if (graphService.storage) {
        result.storage = graphService.storage;
      }
      if (graphService.index) {
        result.index = graphService.index;
      }
      
      return result;
    }
  }
  
  // Fall back to environment variables for backwards compatibility
  // This supports existing deployments that use environment variables
  if (process.env.JANUSGRAPH_HOST || process.env.JANUSGRAPH_PORT) {
    const result: {
      type: 'janusgraph' | 'neptune' | 'neo4j' | 'memory';
      host?: string;
      port?: number;
      storage?: string;
      index?: string;
    } = {
      type: 'janusgraph',
      host: process.env.JANUSGRAPH_HOST || 'localhost',
      port: process.env.JANUSGRAPH_PORT ? parseInt(process.env.JANUSGRAPH_PORT) : 8182
    };
    
    if (process.env.JANUSGRAPH_STORAGE) {
      result.storage = process.env.JANUSGRAPH_STORAGE;
    }
    if (process.env.JANUSGRAPH_INDEX) {
      result.index = process.env.JANUSGRAPH_INDEX;
    }
    
    return result;
  }
  
  // Default to in-memory for development
  return {
    type: 'memory'
  };
}