/**
 * Environment Loader Module
 * 
 * Responsible for loading and merging environment configurations.
 * Handles semiont.json base config and environment-specific overrides.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ConfigurationError } from './configuration-error.js';
import { findProjectRoot } from './project-discovery.js';
import { PlatformType } from './platform-types.js';
import { isObject } from '@semiont/sdk';

/**
 * Environment configuration structure
 */
export interface EnvironmentConfig {
  _comment?: string;  // Optional comment for documentation
  platform?: {
    default?: PlatformType;  // No fallback - must be explicit
  };
  services: Record<string, ServiceConfig>;
  aws?: AWSConfig;
  site?: SiteConfig;
  app?: AppConfig;
  env?: {
    NODE_ENV?: 'development' | 'production' | 'test';
    [key: string]: string | undefined;
  };
  cloud?: {
    aws?: {
      stacks?: {
        data?: string;
        app?: string;
      };
    };
  };
  deployment?: {
    imageTagStrategy?: 'mutable' | 'immutable' | 'git-hash';
  };
}

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

export interface SiteConfig {
  siteName: string;
  domain: string;
  adminEmail: string;
  supportEmail?: string;
  oauthAllowedDomains?: string[];
}

export interface AppConfig {
  features?: {
    enableAnalytics?: boolean;
    enableMaintenanceMode?: boolean;
    enableDebugLogging?: boolean;
  };
  security?: {
    sessionTimeout?: number;
    maxLoginAttempts?: number;
    corsAllowedOrigins?: string[];
  };
  performance?: {
    enableCaching?: boolean;
    cacheTimeout?: number;
    maxRequestSize?: string;
  };
}

/**
 * Deep merge utility for configuration objects
 */
function deepMerge(target: any, ...sources: any[]): any {
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
 * Replaces ${VAR_NAME} with the value from process.env
 *
 * @param obj - Configuration object to process
 * @returns Configuration with resolved environment variables
 */
function resolveEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    // Replace ${VAR_NAME} with actual environment variable value
    return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      return process.env[varName] || match;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(item => resolveEnvVars(item));
  }

  if (obj && typeof obj === 'object') {
    const resolved: any = {};
    for (const key in obj) {
      resolved[key] = resolveEnvVars(obj[key]);
    }
    return resolved;
  }

  return obj;
}

/**
 * Load environment configuration
 * Merges semiont.json with environment-specific config
 * 
 * @param environment - Environment name
 * @param configFile - Optional path to semiont.json
 * @returns Merged environment configuration
 * @throws ConfigurationError if files are missing or invalid
 */
export function loadEnvironmentConfig(environment: string, configFile?: string): EnvironmentConfig {
  try {
    const projectRoot = findProjectRoot();
    
    // Load base semiont.json
    const baseConfigPath = configFile || path.join(projectRoot, 'semiont.json');
    let baseConfig: any = {};
    if (fs.existsSync(baseConfigPath)) {
      const baseContent = fs.readFileSync(baseConfigPath, 'utf-8');
      baseConfig = JSON.parse(baseContent);
    }
    
    // Load environment-specific config
    const envPath = path.join(projectRoot, 'environments', `${environment}.json`);
    
    if (!fs.existsSync(envPath)) {
      throw new ConfigurationError(
        `Environment configuration missing: ${envPath}`, 
        environment,
        `Create the configuration file or use: semiont init`
      );
    }
    
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const envConfig = JSON.parse(envContent);
    
    // Merge configurations: base defaults -> environment config
    const merged = deepMerge(
      {},
      { site: baseConfig.site },           // Site config from semiont.json
      baseConfig.defaults || {},           // Default config from semiont.json
      envConfig                            // Environment-specific overrides
    );

    // Resolve environment variables in the merged configuration
    const resolved = resolveEnvVars(merged);

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

    return resolved as EnvironmentConfig;
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
      `Failed to load environment configuration: ${message}`,
      environment,
      `Check the configuration files exist and are valid JSON`
    );
  }
}

/**
 * Get NODE_ENV value from environment config
 * 
 * @param environment - Environment name
 * @returns NODE_ENV value
 * @throws ConfigurationError if not specified
 */
export function getNodeEnvForEnvironment(environment: string): 'development' | 'production' | 'test' {
  const config = loadEnvironmentConfig(environment);
  const nodeEnv = config.env?.NODE_ENV;
  
  if (!nodeEnv) {
    throw new ConfigurationError(
      `NODE_ENV not specified for environment '${environment}'`,
      environment,
      `Add NODE_ENV to environments/${environment}.json:
    "env": {
      "NODE_ENV": "development" // or "production" or "test"
    }`
    );
  }
  
  return nodeEnv;
}

/**
 * Get available environments by scanning environments directory
 * 
 * @returns Array of environment names
 */
export function getAvailableEnvironments(): string[] {
  try {
    const projectRoot = findProjectRoot();
    const configDir = path.join(projectRoot, 'environments');
    
    if (!fs.existsSync(configDir)) {
      return [];
    }
    
    return fs.readdirSync(configDir)
      .filter(file => file.endsWith('.json'))
      .map(file => path.basename(file, '.json'))
      .sort();
  } catch (error) {
    return [];
  }
}

/**
 * Check if an environment exists
 * 
 * @param environment - Environment name to check
 * @returns True if environment exists
 */
export function isValidEnvironment(environment: string): boolean {
  return getAvailableEnvironments().includes(environment);
}

/**
 * Type guard to check if config has AWS settings
 * 
 * @param config - Environment configuration
 * @returns True if AWS configuration is present
 */
export function hasAWSConfig(config: EnvironmentConfig): config is EnvironmentConfig & { aws: AWSConfig } {
  return !!config.aws && !!config.aws.region;
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