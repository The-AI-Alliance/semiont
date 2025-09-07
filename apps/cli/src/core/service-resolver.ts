/**
 * Service Resolver Module
 * 
 * Responsible for resolving service platform assignments and deployments.
 * Maps services to their configured platforms based on environment configuration.
 */

import * as path from 'path';
import { PlatformType } from './platform-types.js';
import { ServiceConfig, loadEnvironmentConfig } from './environment-loader.js';
import { ConfigurationError } from './configuration-error.js';
import { findProjectRoot } from './project-discovery.js';

/**
 * Service platform information
 */
export interface ServicePlatformInfo {
  name: string;
  platform: PlatformType;
  config: ServiceConfig;
}

/**
 * Get platform type for a specific service in an environment
 * 
 * @param serviceName - Name of the service
 * @param environment - Environment name
 * @returns Platform type for the service
 * @throws ConfigurationError if service not found or platform not specified
 */
export function getServicePlatform(
  serviceName: string, 
  environment: string
): PlatformType {
  const config = loadEnvironmentConfig(environment);
  const serviceConfig = config.services?.[serviceName];
  
  if (!serviceConfig) {
    throw new ConfigurationError(
      `Service '${serviceName}' not found in environment '${environment}'`,
      environment,
      `Add '${serviceName}' to environments/${environment}.json`
    );
  }
  
  // Service-specific platform type takes precedence
  if (serviceConfig.platform?.type) {
    return serviceConfig.platform.type;
  }
  
  // Fall back to environment default
  if (config.platform?.default) {
    return config.platform.default;
  }
  
  // No default - require explicit configuration
  throw new ConfigurationError(
    `Platform not specified for service '${serviceName}'`,
    environment,
    `Add platform configuration to the service or set a default platform in environments/${environment}.json:
    "platform": { "default": "container" }
    OR
    "services": {
      "${serviceName}": {
        "platform": { "type": "container" }
      }
    }`
  );
}

/**
 * Resolve service deployments for requested services
 * 
 * @param serviceNames - Array of service names
 * @param environment - Environment name
 * @returns Array of service platform information
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
      const configPath = path.join(projectRoot, 'environments', `${environment}.json`);
      
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
    
    // Determine platform with proper error handling
    let platform: PlatformType;
    try {
      platform = getServicePlatform(serviceName, environment);
    } catch (error) {
      if (error instanceof ConfigurationError) {
        console.error(error.toString());
      } else {
        console.error(`❌ Failed to determine platform for service '${serviceName}': ${error}`);
      }
      continue; // Skip this service but continue with others
    }
    
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
 * 
 * @param platform - Platform type to filter by
 * @param environment - Environment name
 * @returns Array of services on the specified platform
 */
export function getServicesByPlatform(
  platform: PlatformType,
  environment: string
): ServicePlatformInfo[] {
  const config = loadEnvironmentConfig(environment);
  const matchingServices: ServicePlatformInfo[] = [];
  
  for (const [serviceName, serviceConfig] of Object.entries(config.services || {})) {
    // Determine service platform
    let servicePlatform: PlatformType | undefined;
    if (serviceConfig.platform?.type) {
      servicePlatform = serviceConfig.platform.type;
    } else if (config.platform?.default) {
      servicePlatform = config.platform.default;
    }
    
    // Skip services without platform configuration
    if (!servicePlatform) {
      console.warn(`⚠️  Skipping service '${serviceName}' - no platform specified`);
      continue;
    }
    
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
 * Get all configured services in an environment
 * 
 * @param environment - Environment name
 * @returns Array of service names
 */
export function getServicesInEnvironment(environment: string): string[] {
  const config = loadEnvironmentConfig(environment);
  return Object.keys(config.services || {});
}

/**
 * Check if a service exists in an environment
 * 
 * @param serviceName - Service name to check
 * @param environment - Environment name
 * @returns True if service exists
 */
export function serviceExistsInEnvironment(
  serviceName: string,
  environment: string
): boolean {
  const config = loadEnvironmentConfig(environment);
  return serviceName in (config.services || {});
}