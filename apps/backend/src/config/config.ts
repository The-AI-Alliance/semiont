/**
 * Backend Configuration Helpers
 *
 * Simple wrappers around @semiont/core configuration loading
 * for backend-specific config sections.
 */

import { loadEnvironmentConfig, findProjectRoot } from '@semiont/core';

/**
 * Load environment config once and cache it
 */
let cachedConfig: any = null;

function getConfig() {
  if (!cachedConfig) {
    const environment = process.env.SEMIONT_ENV;
    if (!environment) {
      throw new Error('SEMIONT_ENV environment variable is required');
    }
    const projectRoot = findProjectRoot();
    cachedConfig = loadEnvironmentConfig(projectRoot, environment);
  }
  return cachedConfig;
}

/**
 * Get graph database configuration
 */
export function getGraphConfig() {
  const config = getConfig();

  if (!config.services?.graph) {
    throw new Error('services.graph is required in environment config');
  }

  const graphService = config.services.graph;

  if (!graphService.type) {
    throw new Error('services.graph.type is required in environment config');
  }

  const validTypes = ['janusgraph', 'neptune', 'neo4j', 'memory'];
  if (!validTypes.includes(graphService.type)) {
    throw new Error(`Invalid graph service type: ${graphService.type}. Must be one of: ${validTypes.join(', ')}`);
  }

  return graphService;
}

/**
 * Get inference service configuration
 */
export function getInferenceConfig(): {
  type: string;
  model?: string;
  endpoint?: string;
  maxTokens?: number;
  apiKey?: string;
} {
  const config = getConfig();

  if (!config.services?.inference) {
    throw new Error('services.inference is required in environment config');
  }

  const inference = config.services.inference;

  // Expand environment variables in config values
  const expandedConfig: {
    type: string;
    model?: string;
    endpoint?: string;
    maxTokens?: number;
    apiKey?: string;
  } = {
    type: inference.type,
    model: inference.model,
    endpoint: inference.endpoint || inference.baseURL,
    maxTokens: inference.maxTokens
  };

  // Handle apiKey with environment variable expansion
  if (inference.apiKey) {
    if (inference.apiKey.startsWith('${') && inference.apiKey.endsWith('}')) {
      const envVarName = inference.apiKey.slice(2, -1);
      expandedConfig.apiKey = process.env[envVarName];
    } else {
      expandedConfig.apiKey = inference.apiKey;
    }
  }

  return expandedConfig;
}

/**
 * Reset cached config (for testing)
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}
