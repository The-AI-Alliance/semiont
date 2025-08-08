/**
 * Semiont Configuration Manager
 * 
 * Central configuration export that merges base config with environment overrides
 * and provides a clean API for accessing configuration throughout the application.
 */

import { siteConfig, awsConfig, appConfig } from './base';
import { validateConfiguration, ConfigurationError } from './schemas/validation';
import type { SemiontConfiguration, EnvironmentOverrides } from './schemas/config.schema';

// Dynamic environment loading from JSON files
function getEnvironmentOverrides(environment: string): EnvironmentOverrides {
  try {
    const path = require('path');
    const fs = require('fs');
    
    // Load JSON configuration (from source directory, not dist)
    const jsonPath = path.resolve(__dirname, '../environments/', `${environment}.json`);
    if (fs.existsSync(jsonPath)) {
      const jsonContent = fs.readFileSync(jsonPath, 'utf-8');
      let config = JSON.parse(jsonContent);
      
      // Handle inheritance with _extends
      if (config._extends) {
        const baseConfig = getEnvironmentOverrides(config._extends);
        config = deepMerge(baseConfig, config);
      }
      
      // Remove comment fields
      config = removeCommentFields(config);
      
      return config;
    }
    
    throw new Error(`Configuration file not found: environments/${environment}.json`);
  } catch (error) {
    console.warn(`Failed to load environment '${environment}': ${error instanceof Error ? error.message : String(error)}`);
    console.warn(`Using development config as fallback`);
    
    // Fallback to development
    return getEnvironmentOverrides('development');
  }
}

// Helper to remove comment fields from configuration
function removeCommentFields(obj: any): any {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(removeCommentFields);
  }
  
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    // Skip fields starting with _ (comments, metadata)
    if (!key.startsWith('_')) {
      result[key] = removeCommentFields(value);
    }
  }
  
  return result;
}

// Deep merge helper that handles partial types
function deepMerge(target: any, source: any): any {
  const result = { ...target };
  
  for (const key in source) {
    if (source[key] !== undefined) {
      if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key]) && !(source[key] instanceof URL)) {
        result[key] = deepMerge(
          result[key] || {},
          source[key]
        );
      } else {
        result[key] = source[key];
      }
    }
  }
  
  return result;
}

// Convert string URLs to URL objects
function normalizeUrls(config: SemiontConfiguration): SemiontConfiguration {
  const normalized = { ...config };
  
  if (normalized.app.backend?.url && typeof normalized.app.backend.url === 'string') {
    normalized.app.backend.url = new URL(normalized.app.backend.url);
  }
  
  if (normalized.app.frontend?.url && typeof normalized.app.frontend.url === 'string') {
    normalized.app.frontend.url = new URL(normalized.app.frontend.url);
  }
  
  return normalized;
}

// Build final configuration
function buildConfiguration(environment: string): SemiontConfiguration {
  const overrides = getEnvironmentOverrides(environment);
  
  let config: SemiontConfiguration = {
    site: deepMerge(siteConfig, overrides.site || {}),
    aws: deepMerge(awsConfig, overrides.aws || {}),
    app: deepMerge(appConfig, overrides.app || {})
  };
  
  // Normalize URLs (convert strings to URL objects)
  config = normalizeUrls(config);
  
  // Validate configuration
  try {
    // Determine environment type based on presence of stack classes
    const isCloudEnvironment = Boolean(overrides.stacks?.infraStack && overrides.stacks?.appStack);
    const skipAWSValidation = !isCloudEnvironment;
    validateConfiguration(config, { skipAWSValidation });
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      console.error(`Configuration Error: ${error.message}`);
      if (error.field) {
        console.error(`Field: ${error.field}`);
      }
      throw error;
    }
    throw error;
  }
  
  return config;
}

// Load configuration for a specific environment (clean API)
export function loadConfig(environment: string = 'development'): SemiontConfiguration {
  return buildConfiguration(environment);
}

// Default configuration - uses development unless NODE_ENV suggests otherwise
const defaultEnvironment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
export const config = buildConfiguration(defaultEnvironment);

// Export individual sections for convenience
export const { site, aws, app } = config;

// Export types
export * from './schemas/config.schema';
export { ConfigurationError } from './schemas/validation';

// Export sub-modules for direct access
export * as base from './base';

// Utility functions (work with default config)


export function getEnvironment(): string {
  return defaultEnvironment;
}

export function getFullDomain(): string {
  return config.site.subdomain 
    ? `${config.site.subdomain}.${config.site.domain}`
    : config.site.domain;
}

export function getBackendUrl(): string {
  const backend = config.app.backend;
  if (!backend?.url) {
    throw new Error('Backend URL not configured');
  }
  return backend.url.origin; // Use origin instead of toString() to avoid trailing slash
}

export function getFrontendUrl(): string {
  const frontend = config.app.frontend;
  if (!frontend?.url) {
    throw new Error('Frontend URL not configured');
  }
  return frontend.url.origin; // Use origin instead of toString() to avoid trailing slash
}

export function getBackendUrlObject(): URL {
  const backend = config.app.backend;
  if (!backend?.url) {
    throw new Error('Backend URL not configured');
  }
  return backend.url;
}

export function getFrontendUrlObject(): URL {
  const frontend = config.app.frontend;
  if (!frontend?.url) {
    throw new Error('Frontend URL not configured');
  }
  return frontend.url;
}

// Configuration display for debugging (masks sensitive data)
export function displayConfiguration(): void {
  const safeConfig = JSON.parse(JSON.stringify(config, (_key, value) => {
    // Convert URL objects to strings for display
    if (value instanceof URL) {
      return value.toString();
    }
    return value;
  }));
  
  // Mask sensitive values
  safeConfig.aws.certificateArn = safeConfig.aws.certificateArn.substring(0, 30) + '...';
  safeConfig.aws.accountId = '****' + safeConfig.aws.accountId.substring(8);
  
  console.log('Current Configuration:');
  console.log(JSON.stringify(safeConfig, null, 2));
}