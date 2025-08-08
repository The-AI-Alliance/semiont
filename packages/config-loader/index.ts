/**
 * Semiont Configuration Manager
 * 
 * Central configuration export that merges base config with environment overrides
 * and provides a clean API for accessing configuration throughout the application.
 */

import { siteConfig, awsConfig, appConfig } from './base';
import { validateConfiguration, ConfigurationError } from './schemas/validation';
import type { SemiontConfiguration, EnvironmentOverrides, EnvironmentConfig } from './schemas/config.schema';

import * as path from 'path';
import * as fs from 'fs';

/**
 * Find project root by looking for config/environments directory
 * This is the single source of truth for locating the config directory
 */
export function findProjectRoot(): string {
  // Use SEMIONT_ROOT if set
  if (process.env.SEMIONT_ROOT) {
    return process.env.SEMIONT_ROOT;
  }
  
  // Walk up from current directory to find config/environments
  let currentDir = process.cwd();
  while (currentDir !== '/' && currentDir) {
    if (fs.existsSync(path.join(currentDir, 'config', 'environments'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  
  // Fallback to current directory if not found
  return process.cwd();
}


// Dynamic environment loading from JSON files
function getEnvironmentOverrides(environment: string): EnvironmentConfig {
  try {
    const projectRoot = findProjectRoot();
    const jsonPath = path.join(projectRoot, 'config', 'environments', `${environment}.json`);
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
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Failed to load environment '${environment}': ${message}`);
    throw new Error(`Cannot load configuration for environment '${environment}': ${message}`);
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


// Build final configuration  
function buildConfiguration(environment: string): SemiontConfiguration {
  const overrides = getEnvironmentOverrides(environment);
  
  let config: SemiontConfiguration = {
    site: deepMerge(siteConfig, overrides.site || {}),
    aws: deepMerge(awsConfig, overrides.aws || {}),
    app: deepMerge(appConfig, overrides.app || {})
  };
  
  // Validate configuration
  try {
    // Determine environment type based on presence of cloud AWS stacks
    const isCloudEnvironment = Boolean(overrides.cloud?.aws?.stacks);
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

// Load environment config directly
export function loadEnvironmentConfig(environment: string): EnvironmentConfig {
  return getEnvironmentOverrides(environment);
}

// No default configuration - always require explicit environment
// Use loadConfig(environment) instead

// Export types
export * from './schemas/config.schema';
export { ConfigurationError } from './schemas/validation';

// Export sub-modules for direct access
export * as base from './base';

// Utility functions (work with default config)


// Utility functions removed - use loadConfig(environment) instead and access properties directly

// URL utilities removed - use services configuration instead

// Configuration display utility - pass in loaded config
export function displayConfiguration(config: SemiontConfiguration): void {
  const safeConfig = JSON.parse(JSON.stringify(config, (_key, value) => {
    // Convert URL objects to strings for display
    if (value instanceof URL) {
      return value.toString();
    }
    return value;
  }));
  
  // Mask sensitive values
  if (safeConfig.aws.certificateArn) {
    safeConfig.aws.certificateArn = safeConfig.aws.certificateArn.substring(0, 30) + '...';
  }
  if (safeConfig.aws.accountId) {
    safeConfig.aws.accountId = '****' + safeConfig.aws.accountId.substring(8);
  }
  
  console.log('Configuration:');
  console.log(JSON.stringify(safeConfig, null, 2));
}