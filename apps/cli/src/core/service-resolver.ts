/**
 * Service Resolver Module
 * 
 * Responsible for resolving service platform assignments and deployments.
 * Maps services to their configured platforms based on environment configuration.
 */

import * as path from 'path';
import { PlatformType, EnvironmentConfig } from '@semiont/core';
import { ServiceConfig } from '@semiont/core';
import { ConfigurationError } from '@semiont/core';

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
 * @param config - Environment configuration (includes _metadata with environment name)
 * @returns Platform type for the service
 * @throws ConfigurationError if service not found or platform not specified
 */
export function getServicePlatform(
  serviceName: string,
  config: EnvironmentConfig
): PlatformType {
  const environment = config._metadata?.environment || 'unknown';
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
 * @param config - Environment configuration (includes _metadata with environment and projectRoot)
 * @returns Array of service platform information
 */
export function resolveServiceDeployments(
  serviceNames: string[],
  config: EnvironmentConfig
): ServicePlatformInfo[] {
  const environment = config._metadata?.environment || 'unknown';
  const projectRoot = config._metadata?.projectRoot || process.cwd();
  const platformInfos: ServicePlatformInfo[] = [];

  for (const serviceName of serviceNames) {
    const serviceConfig = config.services?.[serviceName];
    if (!serviceConfig) {
      const availableServices = Object.keys(config.services || {});
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
      platform = getServicePlatform(serviceName, config);
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
 * @param config - Environment configuration
 * @returns Array of services on the specified platform
 */
export function getServicesByPlatform(
  platform: PlatformType,
  config: EnvironmentConfig
): ServicePlatformInfo[] {
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
 * @param config - Environment configuration
 * @returns Array of service names
 */
export function getServicesInEnvironment(config: EnvironmentConfig): string[] {
  return Object.keys(config.services || {});
}

/**
 * Check if a service exists in an environment
 *
 * @param serviceName - Service name to check
 * @param config - Environment configuration
 * @returns True if service exists
 */
export function serviceExistsInEnvironment(
  serviceName: string,
  config: EnvironmentConfig
): boolean {
  return serviceName in (config.services || {});
}