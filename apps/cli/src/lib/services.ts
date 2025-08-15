/**
 * Centralized service management for Semiont CLI
 * 
 * This module provides centralized service discovery and validation,
 * supporting both built-in services and custom services from environment configs.
 */

import * as path from 'path';
import * as fs from 'fs';

// Walk up from current directory to find project root
function findProjectRoot(): string {
  // Common project markers - look for any of these
  const projectMarkers = ['package.json', '.git', 'config/environments'];
  
  let currentDir = process.cwd();
  while (currentDir !== '/' && currentDir) {
    for (const marker of projectMarkers) {
      if (fs.existsSync(path.join(currentDir, marker))) {
        // For config/environments specifically, this is definitely the right directory
        if (marker === 'config/environments') {
          return currentDir;
        }
        // For package.json and .git, check if config/environments also exists
        if (fs.existsSync(path.join(currentDir, 'config', 'environments'))) {
          return currentDir;
        }
      }
    }
    currentDir = path.dirname(currentDir);
  }
  
  // Fallback to current directory if not found
  return process.cwd();
}

// Built-in services that are always available
export const BUILT_IN_SERVICES = ['frontend', 'backend', 'database', 'filesystem'] as const;

export type BuiltInService = typeof BUILT_IN_SERVICES[number];
export type ServiceName = BuiltInService | string; // Allow custom services
export type ServiceSelector = 'all' | ServiceName;

/**
 * Central type definition for all service capabilities
 * This should be the single source of truth for what operations can be performed on services
 */
export type ServiceCapability = 
  | 'publish' 
  | 'start' 
  | 'stop' 
  | 'restart' 
  | 'test' 
  | 'backup' 
  | 'check' 
  | 'exec'
  | 'update'
  | 'provision'
  | 'configure'
  | 'watch';

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
    const PROJECT_ROOT = findProjectRoot();
    const configPath = path.join(PROJECT_ROOT, 'config', 'environments', `${environment}.json`);
    
    if (!fs.existsSync(configPath)) {
      console.warn(`❌ Environment configuration missing: ${configPath}`);
      console.warn(`   To fix: Create the configuration file with service definitions`);
      console.warn(`   You can copy from another environment or use: semiont configure --environment ${environment}`);
      console.warn(`   Using built-in services only: ${BUILT_IN_SERVICES.join(', ')}`);
      console.warn('');
      return [...BUILT_IN_SERVICES];
    }
    
    const jsonContent = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(jsonContent);
    
    const services = config.services ? Object.keys(config.services) : [];
    environmentServicesCache.set(environment, services);
    return services;
  } catch (error) {
    // If we can't load the environment config, return built-in services
    const PROJECT_ROOT = findProjectRoot();
    const configPath = path.join(PROJECT_ROOT, 'config', 'environments', `${environment}.json`);
    
    console.warn(`❌ Failed to load environment configuration for '${environment}'`);
    console.warn(`   Config file: ${configPath}`);
    if (error instanceof Error) {
      if (error.message.includes('JSON')) {
        console.warn(`   Error: Invalid JSON syntax in configuration file`);
        console.warn(`   Tip: Check for missing commas, quotes, or brackets`);
      } else {
        console.warn(`   Error: ${error.message}`);
      }
    }
    console.warn(`   Using built-in services only: ${BUILT_IN_SERVICES.join(', ')}`);
    console.warn('');
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
  capability: ServiceCapability,
  environment?: string
): Promise<string[]> {
  const allServices = await getAvailableServices(environment);
  
  switch (capability) {
    case 'publish':
      // Only containerized services can be published (frontend, backend)
      // filesystem and database don't get "published" in the build/push sense
      return allServices.filter(service => 
        service === 'frontend' || service === 'backend'
      );
    
    case 'backup':
      // Database and filesystem services can be backed up
      return allServices.filter(service => 
        service === 'database' || service === 'filesystem'
      );
    
    case 'provision':
      // Infrastructure provisioning typically for database and filesystem
      return allServices.filter(service => 
        service === 'database' || service === 'filesystem'
      );
    
    case 'start':
    case 'stop':
    case 'restart':
    case 'test':
    case 'check':
    case 'exec':
    case 'update':
    case 'configure':
    case 'watch':
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
    const configPath = path.join(findProjectRoot(), 'config', 'environments', `${environment || 'default'}.json`);
    
    const errorMessage = [
      `❌ Unknown service '${selector}' in environment '${environment}'`,
      `   Available services: ${availableServices.join(', ')}`,
      `   To fix: Add '${selector}' service to ${configPath}`,
      `   Or choose from available services: ${availableServices.join(', ')}`
    ].join('\n');
    
    throw new Error(errorMessage);
  }
}

/**
 * Create a Zod enum schema for services based on capability and environment
 * This is used for runtime validation but allows dynamic service discovery
 */
export function createServiceEnum(capability?: 'publish' | 'start' | 'stop' | 'restart' | 'test' | 'backup' | 'check') {
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
  capability: ServiceCapability,
  environment?: string
): Promise<void> {
  try {
    await resolveServiceSelector(selector, capability, environment);
  } catch (error) {
    throw error;
  }
}