/**
 * Environment configuration loader for backend
 * Reads configuration from environment JSON files
 */

import * as fs from 'fs';
import * as path from 'path';

interface GraphServiceConfig {
  type: 'janusgraph' | 'neptune' | 'neo4j' | 'memory';  // Required field
  port?: number;
  host?: string;
  storage?: 'cassandra' | 'berkeleydb';
  index?: 'elasticsearch' | 'none';
  [key: string]: any;
}

interface FilesystemServiceConfig {
  path: string;  // Required field
  [key: string]: any;
}

interface InferenceServiceConfig {
  type: 'anthropic' | 'openai';  // Required field
  model?: string;
  endpoint?: string;
  apiKey?: string;
  maxTokens?: number;
  [key: string]: any;
}

interface EnvironmentConfig {
  services?: {
    graph?: GraphServiceConfig;
    filesystem?: FilesystemServiceConfig;
    inference?: InferenceServiceConfig;
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * Get the project root directory
 * Project root is either SEMIONT_ROOT or cwd
 * Always returns an absolute path
 */
export function getProjectRoot(): string {
  const root = process.env.SEMIONT_ROOT || process.cwd();
  return path.resolve(root);
}

/**
 * Load environment configuration from JSON file
 * Environment files are at <project_root>/environments/<environment>.json
 */
export function loadEnvironmentConfig(): EnvironmentConfig | null {
  try {
    // Get environment name from SEMIONT_ENV or NODE_ENV
    const envName = process.env.SEMIONT_ENV || process.env.NODE_ENV || 'local';
    
    // Project root is either SEMIONT_ROOT or cwd
    const projectRoot = getProjectRoot();
    
    // Environment file is deterministically at <project_root>/environments/<environment>.json
    const envPath = path.join(projectRoot, 'environments', `${envName}.json`);
    
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      return JSON.parse(content);
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
  
  if (envConfig?.services?.graph) {
    const graphService = envConfig.services.graph;
    
    if (!graphService.type) {
      throw new Error('Graph service configuration must specify a "type" field (janusgraph, neptune, neo4j, or memory)');
    }
    
    const validTypes = ['janusgraph', 'neptune', 'neo4j', 'memory'];
    if (!validTypes.includes(graphService.type)) {
      throw new Error(`Invalid graph service type: ${graphService.type}. Must be one of: ${validTypes.join(', ')}`);
    }
    
    const result: {
      type: 'janusgraph' | 'neptune' | 'neo4j' | 'memory';
      host?: string;
      port?: number;
      storage?: string;
      index?: string;
    } = {
      type: graphService.type,
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

  // If no configuration found, error
  throw new Error('Graph service configuration not found. Please specify graph service settings your environment configuration.');
}

/**
 * Get filesystem service configuration from environment
 */
export function getFilesystemConfig(): {
  path: string;
} {
  // Load from environment JSON
  const envConfig = loadEnvironmentConfig();
  
  if (envConfig?.services?.filesystem) {
    const filesystemService = envConfig.services.filesystem;
    
    if (!filesystemService.path) {
      throw new Error('Filesystem service configuration must specify a "path" field');
    }
    
    let resolvedPath = filesystemService.path;
    
    // If path is relative, prepend project root
    if (!path.isAbsolute(resolvedPath)) {
      const projectRoot = getProjectRoot();
      resolvedPath = path.join(projectRoot, resolvedPath);
    }
    
    return {
      path: resolvedPath
    };
  }
  
  // If no configuration found, error
  throw new Error('Filesystem service configuration not found. Please specify services.filesystem.path in your environment configuration.');
}

/**
 * Get inference service configuration from environment
 */
export function getInferenceConfig(): InferenceServiceConfig {
  // First try to load from environment JSON
  const envConfig = loadEnvironmentConfig();
  console.log('Environment config loaded from:', process.env.SEMIONT_ROOT || process.cwd());
  console.log('Has inference config:', !!envConfig?.services?.inference);

  if (envConfig?.services?.inference) {
    const config = envConfig.services.inference;
    console.log('Raw inference config:', config);

    // Expand environment variables in config values
    const expandedConfig: InferenceServiceConfig = {
      type: config.type,
      model: config.model,
      endpoint: config.endpoint || config.baseURL,
      maxTokens: config.maxTokens
    };

    // Handle apiKey with environment variable expansion
    if (config.apiKey) {
      if (config.apiKey.startsWith('${') && config.apiKey.endsWith('}')) {
        const envVarName = config.apiKey.slice(2, -1);
        expandedConfig.apiKey = process.env[envVarName];
      } else {
        expandedConfig.apiKey = config.apiKey;
      }
    }

    return expandedConfig;
  }

  throw new Error('Inference service configuration not found. Please specify infererence settings in your environment configuration.');
}