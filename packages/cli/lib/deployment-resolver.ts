/**
 * Unified Configuration System - Single source of truth for all environment configuration
 * 
 * This replaces the complex config-loader package with a simple, unified approach
 * that handles service deployment types, AWS configuration, and environment loading.
 */

import * as fs from 'fs';
import * as path from 'path';

export type DeploymentType = 'aws' | 'container' | 'process' | 'external' | 'mock';

export interface ServiceDeploymentInfo {
  name: string;
  deploymentType: DeploymentType;
  config: ServiceConfig;
}

export interface ServiceConfig {
  deployment?: {
    type: DeploymentType;
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
  deployment?: {
    default: DeploymentType;
  };
  services: Record<string, ServiceConfig>;  // Dynamic access - the key fix!
  aws?: AWSConfig;
  site?: SiteConfig;
  app?: AppConfig;
  cloud?: {
    aws?: {
      stacks?: {
        infra?: string;
        app?: string;
      };
    };
  };
}

/**
 * Find project root by looking for config/environments directory
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

/**
 * Load environment configuration - Simple JSON loading without inheritance
 */
export function loadEnvironmentConfig(environment: string): EnvironmentConfig {
  try {
    const projectRoot = findProjectRoot();
    const jsonPath = path.join(projectRoot, 'config', 'environments', `${environment}.json`);
    
    if (!fs.existsSync(jsonPath)) {
      throw new ConfigurationError(
        `Environment configuration missing: ${jsonPath}`, 
        environment,
        `Create the configuration file or use: semiont configure --environment ${environment}`
      );
    }
    
    const jsonContent = fs.readFileSync(jsonPath, 'utf-8');
    const config = JSON.parse(jsonContent) as EnvironmentConfig;
    
    // Ensure services exists (even if empty)
    if (!config.services) {
      config.services = {};
    }
    
    return config;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error; // Re-throw our custom errors
    }
    
    const projectRoot = findProjectRoot();
    const jsonPath = path.join(projectRoot, 'config', 'environments', `${environment}.json`);
    
    if (error instanceof SyntaxError && error.message.includes('JSON')) {
      throw new ConfigurationError(
        `Invalid JSON syntax in configuration file: ${jsonPath}`,
        environment,
        `Check for missing commas, quotes, or brackets. Use a JSON validator to verify syntax.`
      );
    }
    
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(
      `Failed to load environment configuration: ${message}`,
      environment,
      `Check the configuration file: ${jsonPath}`
    );
  }
}

/**
 * Get available environments by scanning config/environments directory
 */
export function getAvailableEnvironments(): string[] {
  try {
    const projectRoot = findProjectRoot();
    const configDir = path.join(projectRoot, 'config', 'environments');
    
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
 * Get deployment type for a specific service in an environment
 */
export function getServiceDeploymentType(
  serviceName: string, 
  environment: string
): DeploymentType {
  const config = loadEnvironmentConfig(environment);
  const serviceConfig = config.services?.[serviceName];
  
  if (!serviceConfig) {
    throw new Error(`Service '${serviceName}' not found in environment '${environment}'`);
  }
  
  // Service-specific deployment type takes precedence
  if (serviceConfig.deployment?.type) {
    return serviceConfig.deployment.type;
  }
  
  // Fall back to environment default
  if (config.deployment?.default) {
    return config.deployment.default;
  }
  
  // Ultimate fallback
  return 'process';
}

/**
 * Get deployment info for all requested services
 */
export function resolveServiceDeployments(
  serviceNames: string[],
  environment: string
): ServiceDeploymentInfo[] {
  const config = loadEnvironmentConfig(environment);
  const deploymentInfos: ServiceDeploymentInfo[] = [];
  
  for (const serviceName of serviceNames) {
    const serviceConfig = config.services?.[serviceName];
    if (!serviceConfig) {
      const availableServices = Object.keys(config.services || {});
      const configPath = path.join(findProjectRoot(), 'config', 'environments', `${environment}.json`);
      
      console.warn(`❌ Service '${serviceName}' not found in environment '${environment}'`);
      if (availableServices.length > 0) {
        console.warn(`   Available services: ${availableServices.join(', ')}`);
      } else {
        console.warn(`   No services configured in this environment`);
      }
      console.warn(`   To fix: Add '${serviceName}' service configuration to ${configPath}`);
      console.warn(`   Example configuration:`);
      console.warn(`   "${serviceName}": {`);
      console.warn(`     "deployment": { "type": "container" },`);
      console.warn(`     "port": 3000`);
      console.warn(`   }`);
      console.warn('');
      continue;
    }
    
    const deploymentType = serviceConfig.deployment?.type || config.deployment?.default || 'process';
    
    deploymentInfos.push({
      name: serviceName,
      deploymentType,
      config: serviceConfig
    });
  }
  
  return deploymentInfos;
}

/**
 * Get all services of a specific deployment type in an environment
 */
export function getServicesByDeploymentType(
  deploymentType: DeploymentType,
  environment: string
): ServiceDeploymentInfo[] {
  const config = loadEnvironmentConfig(environment);
  const matchingServices: ServiceDeploymentInfo[] = [];
  
  for (const [serviceName, serviceConfig] of Object.entries(config.services || {})) {
    const serviceDeploymentType = serviceConfig.deployment?.type || config.deployment?.default || 'process';
    
    if (serviceDeploymentType === deploymentType) {
      matchingServices.push({
        name: serviceName,
        deploymentType,
        config: serviceConfig
      });
    }
  }
  
  return matchingServices;
}

/**
 * Check if a service supports a specific capability based on its deployment type
 */
export function serviceSupportsCapability(
  deploymentType: DeploymentType,
  capability: 'publish' | 'start' | 'stop' | 'restart' | 'test' | 'backup' | 'exec' | 'watch'
): boolean {
  switch (capability) {
    case 'publish':
      // Only containerized services can be published (built/pushed)
      return deploymentType === 'aws' || deploymentType === 'container';
    
    case 'exec':
      // Can exec into AWS ECS tasks and containers, but not processes or external
      return deploymentType === 'aws' || deploymentType === 'container';
    
    case 'backup':
      // Database backups are universal, filesystem backups depend on deployment type
      return true;
    
    case 'start':
    case 'stop':
    case 'restart':
    case 'test':
    case 'watch':
      // All deployment types support these capabilities
      return true;
    
    default:
      return true;
  }
}

/**
 * Filter services by capability based on their deployment types
 */
export function getServicesWithCapability(
  serviceNames: string[],
  capability: 'publish' | 'start' | 'stop' | 'restart' | 'test' | 'backup' | 'exec' | 'watch',
  environment: string
): ServiceDeploymentInfo[] {
  const serviceDeployments = resolveServiceDeployments(serviceNames, environment);
  
  return serviceDeployments.filter(service => 
    serviceSupportsCapability(service.deploymentType, capability)
  );
}