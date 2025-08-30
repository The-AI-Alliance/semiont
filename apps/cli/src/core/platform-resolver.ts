/**
 * Unified Configuration System - Single source of truth for all environment configuration
 * 
 * This replaces the complex config-loader package with a simple, unified approach
 * that handles service deployment types, AWS configuration, and environment loading.
 */

import * as fs from 'fs';
import * as path from 'path';

export type Platform = 'aws' | 'container' | 'posix' | 'external' | 'mock';

export interface ServicePlatformInfo {
  name: string;
  platform: Platform;
  config: ServiceConfig;
}

export interface ServiceConfig {
  platform?: {
    type: Platform;
  };
  // Container/Process fields
  image?: string;
  tag?: string;
  port?: number;
  command?: string;
  host?: string;
  user?: string;
  password?: string;
  name?: string;
  // Filesystem specific
  path?: string;
  mount?: string;
  permissions?: string;
  // AWS-specific fields
  multiAZ?: boolean;
  backupRetentionDays?: number;
  // MCP-specific fields
  authMode?: 'browser' | 'token';
}

export interface AWSConfig {
  region: string;
  accountId: string;
  certificateArn?: string;
  hostedZoneId?: string;
  rootDomain?: string;
  stacks?: {
    infra?: string;
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

export interface EnvironmentConfig {
  platform?: {
    default: Platform;
  };
  services: Record<string, ServiceConfig>;  // Dynamic access - the key fix!
  aws?: AWSConfig;
  site?: SiteConfig;
  app?: AppConfig;
  env?: {
    NODE_ENV?: 'development' | 'production' | 'test';
    [key: string]: string | undefined;  // Allow other env vars in future
  };
  cloud?: {
    aws?: {
      stacks?: {
        infra?: string;
        app?: string;
      };
    };
  };
  deployment?: {
    imageTagStrategy?: 'mutable' | 'immutable' | 'git-hash';
    // Could add more deployment options here in the future
  };
}

/**
 * Get NODE_ENV value from environment config with validation
 */
export function getNodeEnvForEnvironment(environment: string): 'development' | 'production' | 'test' {
  const config = loadEnvironmentConfig(environment);
  const nodeEnv = config.env?.NODE_ENV;
  
  // Validate NODE_ENV value
  if (nodeEnv && !['development', 'production', 'test'].includes(nodeEnv)) {
    throw new ConfigurationError(
      `Invalid NODE_ENV value: ${nodeEnv}`,
      environment,
      `NODE_ENV must be one of: development, production, test`
    );
  }
  
  // Default based on deployment type if not specified
  if (!nodeEnv) {
    // Default to production for AWS, development for local/container
    const platform = config.platform?.default || 'container';
    return platform === 'aws' ? 'production' : 'development';
  }
  
  return nodeEnv;
}

/**
 * Find project root by looking for semiont.json
 */
export function findProjectRoot(): string {
  // Use SEMIONT_ROOT if set
  if (process.env.SEMIONT_ROOT) {
    return process.env.SEMIONT_ROOT;
  }
  
  // Walk up from current directory to find semiont.json
  let currentDir = process.cwd();
  while (currentDir !== '/' && currentDir) {
    if (fs.existsSync(path.join(currentDir, 'semiont.json'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  
  // Fallback: look for environments directory
  currentDir = process.cwd();
  while (currentDir !== '/' && currentDir) {
    if (fs.existsSync(path.join(currentDir, 'environments'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  
  // If not found, throw an error
  throw new ConfigurationError(
    'Not in a Semiont project',
    undefined,
    'Run "semiont init" to initialize a new project'
  );
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

function isObject(item: any): boolean {
  return item && typeof item === 'object' && !Array.isArray(item);
}

/**
 * Load environment configuration - Merges semiont.json with environment-specific config
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
    
    // Ensure services exists (even if empty)
    if (!merged.services) {
      merged.services = {};
    }
    
    return merged as EnvironmentConfig;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error; // Re-throw our custom errors
    }
    
    const projectRoot = findProjectRoot();
    let envPath = path.join(projectRoot, 'environments', `${environment}.json`);
    if (!fs.existsSync(envPath)) {
      envPath = path.join(projectRoot, 'config', 'environments', `${environment}.json`);
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
      `Check the configuration files: semiont.json and ${envPath}`
    );
  }
}

/**
 * Get available environments by scanning environments directory
 */
export function getAvailableEnvironments(): string[] {
  try {
    const projectRoot = findProjectRoot();
    // Try new structure first
    let configDir = path.join(projectRoot, 'environments');
    if (!fs.existsSync(configDir)) {
      // Fallback to old structure
      configDir = path.join(projectRoot, 'config', 'environments');
    }
    
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
 */
export function isValidEnvironment(environment: string): boolean {
  return getAvailableEnvironments().includes(environment);
}

/**
 * Display configuration for debugging
 */
export function displayConfiguration(config: EnvironmentConfig): void {
  console.log('Environment Configuration:');
  console.log(JSON.stringify(config, null, 2));
}

/**
 * Configuration error class for validation and loading errors
 */
export class ConfigurationError extends Error {
  constructor(
    message: string, 
    public environment?: string,
    public suggestion?: string,
    public override readonly cause?: Error
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
  
  // Helper method to format the error nicely
  override toString(): string {
    let output = `❌ ${this.message}`;
    if (this.environment) {
      output += `\n   Environment: ${this.environment}`;
    }
    if (this.suggestion) {
      output += `\n   💡 Suggestion: ${this.suggestion}`;
    }
    return output;
  }
}

/**
 * Get platform type for a specific service in an environment
 */
export function getServicePlatform(
  serviceName: string, 
  environment: string
): Platform {
  const config = loadEnvironmentConfig(environment);
  const serviceConfig = config.services?.[serviceName];
  
  if (!serviceConfig) {
    throw new Error(`Service '${serviceName}' not found in environment '${environment}'`);
  }
  
  // Service-specific platform type takes precedence
  if (serviceConfig.platform?.type) {
    return serviceConfig.platform.type;
  }
  
  // Fall back to environment default
  if (config.platform?.default) {
    return config.platform.default;
  }
  
  // Ultimate fallback
  return 'posix';
}

/**
 * Get platform info for all requested services
 */
export function resolveServiceDeployments(
  serviceNames: string[],
  environment: string
): ServicePlatformInfo[] {
  const config = loadEnvironmentConfig(environment);
  const platformInfos: ServicePlatformInfo[] = [];
  
  for (const serviceName of serviceNames) {
    const serviceConfig = config.services?.[serviceName];
    if (!serviceConfig) {
      const availableServices = Object.keys(config.services || {});
      const projectRoot = findProjectRoot();
      let configPath = path.join(projectRoot, 'environments', `${environment}.json`);
      if (!fs.existsSync(configPath)) {
        configPath = path.join(projectRoot, 'config', 'environments', `${environment}.json`);
      }
      
      console.warn(`❌ Service '${serviceName}' not found in environment '${environment}'`);
      if (availableServices.length > 0) {
        console.warn(`   Available services: ${availableServices.join(', ')}`);
      } else {
        console.warn(`   No services configured in this environment`);
      }
      console.warn(`   To fix: Add '${serviceName}' service configuration to ${configPath}`);
      console.warn(`   Example configuration:`);
      console.warn(`   "${serviceName}": {`);
      console.warn(`     "platform": { "type": "container" },`);
      console.warn(`     "port": 3000`);
      console.warn(`   }`);
      console.warn('');
      continue;
    }
    
    const platform = serviceConfig.platform?.type || config.platform?.default || 'posix';
    
    platformInfos.push({
      name: serviceName,
      platform,
      config: serviceConfig
    });
  }
  
  return platformInfos;
}

/**
 * Get all services of a specific platform type in an environment
 */
export function getServicesByPlatform(
  platform: Platform,
  environment: string
): ServicePlatformInfo[] {
  const config = loadEnvironmentConfig(environment);
  const matchingServices: ServicePlatformInfo[] = [];
  
  for (const [serviceName, serviceConfig] of Object.entries(config.services || {})) {
    const servicePlatform = serviceConfig.platform?.type || config.platform?.default || 'process';
    
    if (servicePlatform === platform) {
      matchingServices.push({
        name: serviceName,
        platform,
        config: serviceConfig
      });
    }
  }
  
  return matchingServices;
}

/**
 * Check if a service supports a specific capability based on its platform type
 */
export function serviceSupportsCapability(
  platform: Platform,
  capability: 'publish' | 'start' | 'stop' | 'restart' | 'test' | 'backup' | 'exec' | 'watch'
): boolean {
  switch (capability) {
    case 'publish':
      // Only containerized services can be published (built/pushed)
      return platform === 'aws' || platform === 'container';
    
    case 'exec':
      // Can exec into AWS ECS tasks and containers, but not processes or external
      return platform === 'aws' || platform === 'container';
    
    case 'backup':
      // Database backups are universal, filesystem backups depend on platform type
      return true;
    
    case 'start':
    case 'stop':
    case 'restart':
    case 'test':
    case 'watch':
      // All platform types support these capabilities
      return true;
    
    default:
      return true;
  }
}

/**
 * Filter services by capability based on their platform types
 */
export function getServicesWithCapability(
  serviceNames: string[],
  capability: 'publish' | 'start' | 'stop' | 'restart' | 'test' | 'backup' | 'exec' | 'watch',
  environment: string
): ServicePlatformInfo[] {
  const serviceDeployments = resolveServiceDeployments(serviceNames, environment);
  
  return serviceDeployments.filter(service => 
    serviceSupportsCapability(service.platform, capability)
  );
}