/**
 * Command-Service Matcher Module → Which work together?
 * 
 * This module determines which commands can operate on which services.
 * It answers the fundamental question: "Can this command work with this service?"
 * 
 * Responsibilities:
 * - Matches commands with compatible services based on capabilities
 * - Resolves "all" to the list of applicable services for a command
 * - Validates that a service supports a given command capability
 * - Contains the business rules for service capabilities
 * 
 * Business Rules (should eventually move to service definitions):
 * - Only frontend/backend services can be "published" (containerized services)
 * - Only database/filesystem services can be "backed up" or "restored"
 * - Most other commands work with all services
 * 
 * This module bridges command-discovery and service-discovery,
 * applying the business logic to determine valid combinations.
 */

import { commandRequiresServices } from './command-discovery.js';
import { getAvailableServices, isValidService, ServiceSelector, ServiceCapability, ServiceName } from './service-discovery.js';
import { EnvironmentConfig, parseEnvironment } from '@semiont/core';
import { resolveServiceDeployments } from './service-resolver.js';
import { ServiceFactory } from '../services/service-factory.js';
import { serviceSupportsCommand } from './service-command-capabilities.js';
import * as path from 'path';

/**
 * Check if a service supports a command by examining its requirements
 *
 * @param serviceName - The service name
 * @param command - The command to check
 * @param envConfig - The environment configuration
 * @returns Whether the service supports the command
 */
async function checkServiceSupportsCommand(
  serviceName: string,
  command: string,
  envConfig: EnvironmentConfig
): Promise<boolean> {
  try {
    const projectRoot = envConfig._metadata?.projectRoot || process.cwd();
    const environment = envConfig._metadata?.environment || 'unknown';

    // Get service deployment info
    const deployments = resolveServiceDeployments(
      [serviceName],
      envConfig
    );

    if (deployments.length === 0) {
      return false;
    }

    // Create service instance to check its requirements
    const deployment = deployments[0];
    const service = ServiceFactory.create(
      serviceName as ServiceName,
      deployment.platform,
      {
        projectRoot,
        environment: parseEnvironment(environment),
        verbose: false,
        quiet: true,
        dryRun: false
      },
      envConfig,
      {
        ...deployment.config,
        platform: deployment.platform
      }
    );

    // Check if service declares support for this command
    const requirements = service.getRequirements();
    return serviceSupportsCommand(requirements.annotations, command);
  } catch {
    // If we can't create the service, assume it doesn't support the command
    return false;
  }
}

/**
 * Get services that support a specific capability
 *
 * @param capability - The command capability
 * @param envConfig - The environment configuration
 * @returns Array of service names that support the capability
 */
export async function getServicesWithCapability(
  capability: ServiceCapability,
  envConfig: EnvironmentConfig
): Promise<string[]> {
  const environment = envConfig._metadata?.environment;
  const allServices = await getAvailableServices(environment);

  // Check if this capability is actually a service command
  const isServiceCommand = await commandRequiresServices(capability);
  if (!isServiceCommand && capability !== 'restore') {
    // 'restore' is not in command-discovery yet but is referenced in the old code
    // Return empty array for non-service commands
    return [];
  }

  // Filter services based on their declared capabilities
  const supportedServices: string[] = [];

  for (const serviceName of allServices) {
    const supportsCommand = await checkServiceSupportsCommand(
      serviceName,
      capability,
      envConfig
    );

    if (supportsCommand) {
      supportedServices.push(serviceName);
    }
  }

  return supportedServices;
}

/**
 * Resolve 'all' to actual service names based on capability and environment
 *
 * @param selector - The service selector ('all' or specific service name)
 * @param capability - The command capability
 * @param envConfig - The environment configuration
 * @returns Array of resolved service names
 */
export async function resolveServiceSelector(
  selector: ServiceSelector,
  capability: ServiceCapability,
  envConfig: EnvironmentConfig
): Promise<string[]> {
  const environment = envConfig._metadata?.environment || 'unknown';

  if (selector === 'all') {
    return getServicesWithCapability(capability, envConfig);
  }

  // Validate the specific service
  if (await isValidService(selector, environment)) {
    // Check if the service supports the capability
    const capableServices = await getServicesWithCapability(capability, envConfig);
    if (capableServices.includes(selector)) {
      return [selector];
    } else {
      throw new Error(`Service '${selector}' does not support capability '${capability}'`);
    }
  } else {
    const availableServices = await getAvailableServices(environment);
    const projectRoot = envConfig._metadata?.projectRoot || process.cwd();
    const configPath = path.join(projectRoot, 'environments', `${environment}.json`);

    const errorMessage = [
      `Unknown service '${selector}' in environment '${environment}'`,
      `Available services: ${availableServices.join(', ')}`,
      `To fix: Add '${selector}' service to ${configPath}`,
      `Or choose from available services: ${availableServices.join(', ')}`
    ].join('\n');

    throw new Error(errorMessage);
  }
}

/**
 * Validate a service selector for a given capability
 *
 * @param selector - The service selector
 * @param capability - The command capability
 * @param envConfig - The environment configuration
 * @throws Error if validation fails
 */
export async function validateServiceSelector(
  selector: ServiceSelector,
  capability: ServiceCapability,
  envConfig: EnvironmentConfig
): Promise<void> {
  // Check if this capability is actually a service command
  const isServiceCommand = await commandRequiresServices(capability);
  if (!isServiceCommand && capability !== 'restore') {
    throw new Error(`Command '${capability}' does not operate on services`);
  }

  // Resolve will throw if invalid
  await resolveServiceSelector(selector, capability, envConfig);
}