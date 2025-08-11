/**
 * Centralized service management for Semiont CLI
 * 
 * This module provides centralized service discovery and validation,
 * supporting both built-in services and custom services from environment configs.
 */

import * as path from 'path';
import { getProjectRoot } from './cli-paths.js';

// Built-in services that are always available
export const BUILT_IN_SERVICES = ['frontend', 'backend', 'database', 'filesystem'] as const;

export type BuiltInService = typeof BUILT_IN_SERVICES[number];
export type ServiceName = BuiltInService | string; // Allow custom services
export type ServiceSelector = 'all' | ServiceName;

// Cache for loaded environment services
const environmentServicesCache = new Map<string, string[]>();

/**
 * Load services from an environment configuration
 */
async function loadEnvironmentServices(environment: string): Promise<string[]> {
  if (environmentServicesCache.has(environment)) {
    return environmentServicesCache.get(environment)!;
  }

  try {
    const PROJECT_ROOT = getProjectRoot(import.meta.url);
    const configPath = path.join(PROJECT_ROOT, 'config', 'environments', `${environment}.json`);
    
    // Dynamic import with type assertion since we can't use import assertions in compiled code
    const configModule = await import(configPath);
    const config = configModule.default || configModule;
    
    const services = config.services ? Object.keys(config.services) : [];
    environmentServicesCache.set(environment, services);
    return services;
  } catch (error) {
    // If we can't load the environment config, return built-in services
    console.warn(`Warning: Could not load services from environment '${environment}', using built-in services only`);
    return [...BUILT_IN_SERVICES];
  }
}

/**
 * Get all available services for a given environment
 */
export async function getAvailableServices(environment?: string): Promise<string[]> {
  if (!environment) {
    return [...BUILT_IN_SERVICES];
  }

  const envServices = await loadEnvironmentServices(environment);
  
  // Combine built-in services with environment-specific services
  const allServices = new Set([...BUILT_IN_SERVICES, ...envServices]);
  return Array.from(allServices).sort();
}

/**
 * Check if a service is valid for the given environment
 */
export async function isValidService(service: string, environment?: string): Promise<boolean> {
  if (service === 'all') return true;
  
  const availableServices = await getAvailableServices(environment);
  return availableServices.includes(service);
}

/**
 * Get services that support a specific capability
 */
export async function getServicesWithCapability(
  capability: 'publish' | 'start' | 'stop' | 'restart' | 'test' | 'backup',
  environment?: string
): Promise<string[]> {
  const allServices = await getAvailableServices(environment);
  
  switch (capability) {
    case 'publish':
      // Only containerized services can be published (frontend, backend)
      // filesystem and database don't get "published" in the build/push sense
      return allServices.filter(service => 
        service === 'frontend' || service === 'backend'
        // TODO: Check deployment.type from config to determine if service is containerized
      );
    
    case 'backup':
      // Database and filesystem services can be backed up
      return allServices.filter(service => 
        service === 'database' || service === 'filesystem'
      );
    
    case 'start':
    case 'stop':
    case 'restart':
    case 'test':
      // All services support these capabilities
      return allServices;
    
    default:
      return allServices;
  }
}

/**
 * Resolve 'all' to actual service names based on capability and environment
 */
export async function resolveServiceSelector(
  selector: ServiceSelector,
  capability: 'publish' | 'start' | 'stop' | 'restart' | 'test' | 'backup',
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
    throw new Error(`Unknown service '${selector}'. Available services: ${availableServices.join(', ')}`);
  }
}

/**
 * Create a Zod enum schema for services based on capability and environment
 * This is used for runtime validation but allows dynamic service discovery
 */
export function createServiceEnum(capability?: 'publish' | 'start' | 'stop' | 'restart' | 'test' | 'backup') {
  // For static schema definition, we use the built-in services
  // Runtime validation will check against actual available services
  const baseServices = ['all', ...BUILT_IN_SERVICES];
  
  if (capability === 'publish') {
    return ['all', 'frontend', 'backend'] as const;
  } else if (capability === 'backup') {
    return ['all', 'database', 'filesystem'] as const;  
  } else {
    return baseServices as readonly string[];
  }
}

/**
 * Validate a service selector at runtime (after environment is known)
 */
export async function validateServiceSelector(
  selector: ServiceSelector,
  capability: 'publish' | 'start' | 'stop' | 'restart' | 'test' | 'backup',
  environment?: string
): Promise<void> {
  try {
    await resolveServiceSelector(selector, capability, environment);
  } catch (error) {
    throw error;
  }
}