/**
 * Environment Loader Module
 *
 * Responsible for loading and merging environment configurations.
 * Handles semiont.json base config and environment-specific overrides.
 */

import { ConfigurationError } from './configuration-error';
import { PlatformType } from './platform-types';
import { isObject } from '../index';
import { validateEnvironmentConfig } from './config-validator';
import type {
  EnvironmentConfig,
  SiteConfig,
  AppConfig,
  SemiontConfig,
  ServicesConfig,
  BackendServiceConfig,
  FrontendServiceConfig,
  DatabaseServiceConfig,
  GraphServiceConfig,
  FilesystemServiceConfig,
  InferenceServiceConfig,
  ServicePlatformConfig
} from './config.types';

/**
 * Re-export generated types from JSON Schema
 * These types are automatically generated from config.schema.json
 */
export type {
  EnvironmentConfig,
  SiteConfig,
  AppConfig,
  SemiontConfig,
  PlatformType,
  ServicesConfig,
  BackendServiceConfig,
  FrontendServiceConfig,
  DatabaseServiceConfig,
  GraphServiceConfig,
  FilesystemServiceConfig,
  InferenceServiceConfig,
  ServicePlatformConfig
};

/**
 * Generic service configuration
 * Platform-specific fields should be accessed through platform-specific interfaces
 */
export interface ServiceConfig {
  platform?: {
    type: PlatformType;
  };
  // Generic fields that apply across platforms
  port?: number;
  name?: string;
  // Platform-specific fields are loosely typed here
  // Platforms should validate and type these properly
  [key: string]: any;
}

export interface AWSConfig {
  region: string;
  accountId: string;
  certificateArn?: string;
  hostedZoneId?: string;
  rootDomain?: string;
  stacks?: {
    data?: string;
    app?: string;
  };
  database?: {
    name?: string;
    instanceClass?: string;
    allocatedStorage?: number;
    backupRetentionDays?: number;
    multiAZ?: boolean;
  };
  ecs?: {
    desiredCount?: number;
    minCapacity?: number;
    maxCapacity?: number;
  };
  monitoring?: {
    enableDetailedMonitoring?: boolean;
    logRetentionDays?: number;
  };
}

/**
 * Deep merge utility for configuration objects
 * Pure function - no side effects
 */
export function deepMerge(target: any, ...sources: any[]): any {
  if (!sources.length) return target;
  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        deepMerge(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return deepMerge(target, ...sources);
}


/**
 * Recursively resolve environment variable placeholders in configuration
 * Replaces ${VAR_NAME} with the value from the provided env object
 * Pure function - accepts env as parameter instead of using process.env
 *
 * @param obj - Configuration object to process
 * @param env - Environment variables object
 * @returns Configuration with resolved environment variables
 */
export function resolveEnvVars(obj: any, env: Record<string, string | undefined>): any {
  if (typeof obj === 'string') {
    // Replace ${VAR_NAME} with actual environment variable value
    return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      return env[varName] || match;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(item => resolveEnvVars(item, env));
  }

  if (obj && typeof obj === 'object') {
    const resolved: any = {};
    for (const key in obj) {
      resolved[key] = resolveEnvVars(obj[key], env);
    }
    return resolved;
  }

  return obj;
}

/**
 * Parse and merge configuration files
 * Pure function - accepts file contents as strings instead of reading from filesystem
 *
 * @param baseContent - Contents of semiont.json (null if file doesn't exist)
 * @param envContent - Contents of environment-specific JSON file
 * @param env - Environment variables object
 * @param environment - Environment name
 * @param projectRoot - Project root path (for metadata only)
 * @returns Merged and validated environment configuration
 * @throws ConfigurationError if parsing or validation fails
 */
export function parseAndMergeConfigs(
  baseContent: string | null,
  envContent: string,
  env: Record<string, string | undefined>,
  environment: string,
  projectRoot: string
): EnvironmentConfig {
  try {
    // Parse base config
    let baseConfig: any = {};
    if (baseContent) {
      baseConfig = JSON.parse(baseContent);
    }

    // Parse environment config
    const envConfig = JSON.parse(envContent);

    // Merge configurations: base defaults -> environment config
    const merged = deepMerge(
      {},
      { site: baseConfig.site },           // Site config from semiont.json
      baseConfig.defaults || {},           // Default config from semiont.json
      envConfig                            // Environment-specific overrides
    );

    // Resolve environment variables in the merged configuration
    const resolved = resolveEnvVars(merged, env);

    // Ensure services exists (even if empty)
    if (!resolved.services) {
      resolved.services = {};
    }

    // Validate NODE_ENV if specified
    if (resolved.env?.NODE_ENV) {
      const validNodeEnv = ['development', 'production', 'test'];
      if (!validNodeEnv.includes(resolved.env.NODE_ENV)) {
        throw new ConfigurationError(
          `Invalid NODE_ENV value: ${resolved.env.NODE_ENV}`,
          environment,
          `NODE_ENV must be one of: ${validNodeEnv.join(', ')}`
        );
      }
    }

    // Add metadata about where this config came from
    const configWithMetadata = {
      ...resolved,
      _metadata: {
        environment,
        projectRoot
      }
    };

    // Validate with AJV
    const validationResult = validateEnvironmentConfig(configWithMetadata);

    if (!validationResult.valid) {
      throw new ConfigurationError(
        `Invalid environment configuration: ${validationResult.errorMessage}`,
        environment,
        `Fix the validation errors in your environments/${environment}.json file`
      );
    }

    return configWithMetadata as EnvironmentConfig;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error; // Re-throw our custom errors
    }

    if (error instanceof SyntaxError && error.message.includes('JSON')) {
      throw new ConfigurationError(
        `Invalid JSON syntax in configuration file`,
        environment,
        `Check for missing commas, quotes, or brackets. Use a JSON validator to verify syntax.`
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(
      `Failed to parse environment configuration: ${message}`,
      environment,
      `Check the configuration files are valid JSON`
    );
  }
}

/**
 * Get NODE_ENV value from environment config
 *
 * @param config - Environment configuration
 * @returns NODE_ENV value (defaults to 'development' if not specified)
 */
export function getNodeEnvForEnvironment(config: EnvironmentConfig): 'development' | 'production' | 'test' {
  const nodeEnv = config.env?.NODE_ENV;

  // Default to 'development' if not specified
  return nodeEnv || 'development';
}

/**
 * List environment names from filenames
 * Pure function - accepts array of filenames instead of reading from filesystem
 *
 * @param files - Array of filenames from environments directory
 * @returns Sorted array of environment names
 */
export function listEnvironmentNames(files: string[]): string[] {
  return files
    .filter(file => file.endsWith('.json'))
    .map(file => {
      // Extract filename from path (handle directory separators)
      const lastSlash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
      const filename = lastSlash >= 0 ? file.substring(lastSlash + 1) : file;
      // Remove '.json' suffix
      return filename.slice(0, -5);
    })
    .sort();
}

/**
 * Type guard to check if config has AWS settings
 * 
 * @param config - Environment configuration
 * @returns True if AWS configuration is present
 */
export function hasAWSConfig(config: EnvironmentConfig): config is EnvironmentConfig & { aws: AWSConfig } {
  return !!(config as any).aws && !!(config as any).aws.region;
}

/**
 * Display configuration for debugging
 * 
 * @param config - Configuration to display
 */
export function displayConfiguration(config: EnvironmentConfig): void {
  console.log('Environment Configuration:');
  console.log(JSON.stringify(config, null, 2));
}