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
import { getAvailableServices, isValidService, ServiceSelector, ServiceCapability } from './service-discovery.js';
import { findProjectRoot } from './platform-resolver.js';
import * as path from 'path';

/**
 * Service capability rules
 * 
 * This defines which services support which command capabilities.
 * Eventually this should be moved to service definitions themselves.
 */
const SERVICE_CAPABILITY_RULES: Record<string, (service: string) => boolean> = {
  'publish': (service) => service === 'frontend' || service === 'backend',
  'backup': (service) => service === 'database' || service === 'filesystem',
  'restore': (service) => service === 'database' || service === 'filesystem',
  // Most commands work with all services by default
};

/**
 * Get services that support a specific capability
 * 
 * @param capability - The command capability
 * @param environment - The environment name (optional)
 * @returns Array of service names that support the capability
 */
export async function getServicesWithCapability(
  capability: ServiceCapability,
  environment?: string
): Promise<string[]> {
  const allServices = await getAvailableServices(environment);
  
  // Check if this capability is actually a service command
  const isServiceCommand = await commandRequiresServices(capability);
  if (!isServiceCommand && capability !== 'restore') {
    // 'restore' is not in command-discovery yet but is referenced in the old code
    // Return empty array for non-service commands
    return [];
  }
  
  // Apply capability rules if defined
  const rule = SERVICE_CAPABILITY_RULES[capability];
  if (rule) {
    return allServices.filter(rule);
  }
  
  // Default: all services support the capability
  return allServices;
}

/**
 * Resolve 'all' to actual service names based on capability and environment
 * 
 * @param selector - The service selector ('all' or specific service name)
 * @param capability - The command capability
 * @param environment - The environment name (optional)
 * @returns Array of resolved service names
 */
export async function resolveServiceSelector(
  selector: ServiceSelector,
  capability: ServiceCapability,
  environment?: string
): Promise<string[]> {
  if (selector === 'all') {
    return getServicesWithCapability(capability, environment);
  }
  
  // Validate the specific service
  if (await isValidService(selector, environment)) {
    // Check if the service supports the capability
    const capableServices = await getServicesWithCapability(capability, environment);
    if (capableServices.includes(selector)) {
      return [selector];
    } else {
      throw new Error(`Service '${selector}' does not support capability '${capability}'`);
    }
  } else {
    const availableServices = await getAvailableServices(environment);
    const configPath = path.join(findProjectRoot(), 'environments', `${environment}.json`);
    
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
 * @param environment - The environment name (optional)
 * @throws Error if validation fails
 */
export async function validateServiceSelector(
  selector: ServiceSelector,
  capability: ServiceCapability,
  environment?: string
): Promise<void> {
  // Check if this capability is actually a service command
  const isServiceCommand = await commandRequiresServices(capability);
  if (!isServiceCommand && capability !== 'restore') {
    throw new Error(`Command '${capability}' does not operate on services`);
  }
  
  // Resolve will throw if invalid
  await resolveServiceSelector(selector, capability, environment);
}