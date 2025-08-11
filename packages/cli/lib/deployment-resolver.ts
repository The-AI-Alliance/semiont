/**
 * Deployment Type Resolver - Determines deployment.type per service from configuration
 * 
 * This utility provides the core logic for determining how each service should be deployed
 * based on its configuration and environment defaults.
 */

import * as path from 'path';
import { getProjectRoot } from './cli-paths.js';

export type DeploymentType = 'aws' | 'container' | 'process' | 'external';

export interface ServiceDeploymentInfo {
  name: string;
  deploymentType: DeploymentType;
  config: ServiceConfig;
}

export interface ServiceConfig {
  deployment?: {
    type: DeploymentType;
  };
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
}

export interface EnvironmentConfig {
  deployment?: {
    default: DeploymentType;
  };
  services: Record<string, ServiceConfig>;
  aws?: {
    region: string;
    accountId: string;
  };
}

// Cache for loaded environment configs
const configCache = new Map<string, EnvironmentConfig>();

/**
 * Load environment configuration from file
 */
export async function loadEnvironmentConfig(environment: string): Promise<EnvironmentConfig> {
  if (configCache.has(environment)) {
    return configCache.get(environment)!;
  }

  try {
    const PROJECT_ROOT = getProjectRoot(import.meta.url);
    const configPath = path.join(PROJECT_ROOT, 'config', 'environments', `${environment}.json`);
    
    // Dynamic import for JSON configuration
    const configModule = await import(configPath);
    const config = configModule.default || configModule;
    
    configCache.set(environment, config);
    return config;
  } catch (error) {
    throw new Error(`Failed to load environment config for '${environment}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get deployment type for a specific service in an environment
 */
export async function getServiceDeploymentType(
  serviceName: string, 
  environment: string
): Promise<DeploymentType> {
  const config = await loadEnvironmentConfig(environment);
  const serviceConfig = config.services[serviceName];
  
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
export async function resolveServiceDeployments(
  serviceNames: string[],
  environment: string
): Promise<ServiceDeploymentInfo[]> {
  const config = await loadEnvironmentConfig(environment);
  const deploymentInfos: ServiceDeploymentInfo[] = [];
  
  for (const serviceName of serviceNames) {
    const serviceConfig = config.services[serviceName];
    if (!serviceConfig) {
      console.warn(`Warning: Service '${serviceName}' not found in environment '${environment}' - skipping`);
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
export async function getServicesByDeploymentType(
  deploymentType: DeploymentType,
  environment: string
): Promise<ServiceDeploymentInfo[]> {
  const config = await loadEnvironmentConfig(environment);
  const matchingServices: ServiceDeploymentInfo[] = [];
  
  for (const [serviceName, serviceConfig] of Object.entries(config.services)) {
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
export async function getServicesWithCapability(
  serviceNames: string[],
  capability: 'publish' | 'start' | 'stop' | 'restart' | 'test' | 'backup' | 'exec' | 'watch',
  environment: string
): Promise<ServiceDeploymentInfo[]> {
  const serviceDeployments = await resolveServiceDeployments(serviceNames, environment);
  
  return serviceDeployments.filter(service => 
    serviceSupportsCapability(service.deploymentType, capability)
  );
}