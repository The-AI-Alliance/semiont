/**
 * Service Discovery Module → What services exist?
 * 
 * This module is responsible for discovering what services are available.
 * It answers the fundamental question: "What services can we work with?"
 * 
 * Responsibilities:
 * - Discovers services from environment configuration files
 * - Manages built-in services (frontend, backend, database, filesystem)
 * - Validates service names
 * - Loads service-specific configuration from environment files
 * - Caches discovered services for performance
 * 
 * Services can come from two sources:
 * 1. Built-in services that are always available
 * 2. Custom services defined in environment/<env>.json files
 * 
 * This module does NOT determine which commands work with which services.
 * That logic belongs in command-service-matcher.ts
 */

import * as path from 'path';
import * as fs from 'fs';
import { findProjectRoot } from './project-discovery.js';

/**
 * Built-in services that are always available
 */
export const BUILT_IN_SERVICES = ['frontend', 'backend', 'database', 'filesystem'] as const;

export type BuiltInService = typeof BUILT_IN_SERVICES[number];
export type ServiceName = string; // Allow any string for custom services
export type ServiceSelector = 'all' | ServiceName;

/**
 * Service capabilities that can be declared
 */
export type ServiceCapability = string; // Commands that a service supports

/**
 * Cache for loaded environment services
 */
const environmentServicesCache = new Map<string, string[]>();

/**
 * Load services from an environment configuration
 * 
 * @param environment - The environment name
 * @returns Array of service names defined in the environment
 */
async function loadEnvironmentServices(environment: string): Promise<string[]> {
  if (environmentServicesCache.has(environment)) {
    return environmentServicesCache.get(environment)!;
  }

  try {
    const PROJECT_ROOT = findProjectRoot();
    const configPath = path.join(PROJECT_ROOT, 'environments', `${environment}.json`);
    
    if (!fs.existsSync(configPath)) {
      // Return built-in services if no config exists
      return [...BUILT_IN_SERVICES];
    }
    
    const jsonContent = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(jsonContent);
    
    const services = config.services ? Object.keys(config.services) : [];
    environmentServicesCache.set(environment, services);
    return services;
  } catch (error) {
    // If we can't load the environment config, return built-in services
    console.warn(`Failed to load environment configuration for '${environment}'`);
    if (error instanceof Error) {
      console.warn(`Error: ${error.message}`);
    }
    return [...BUILT_IN_SERVICES];
  }
}

/**
 * Get all available services for a given environment
 * 
 * @param environment - The environment name (optional)
 * @returns Array of all available service names
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
 * 
 * @param service - The service name
 * @param environment - The environment name (optional)
 * @returns True if the service is valid
 */
export async function isValidService(service: string, environment?: string): Promise<boolean> {
  if (service === 'all') return true;
  
  const availableServices = await getAvailableServices(environment);
  return availableServices.includes(service);
}

/**
 * Get service configuration from environment
 * 
 * @param service - The service name
 * @param environment - The environment name
 * @returns The service configuration object
 */
export async function getServiceConfig(service: string, environment: string): Promise<any> {
  try {
    const PROJECT_ROOT = findProjectRoot();
    const configPath = path.join(PROJECT_ROOT, 'environments', `${environment}.json`);
    
    if (!fs.existsSync(configPath)) {
      return null;
    }
    
    const jsonContent = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(jsonContent);
    
    return config.services?.[service] || null;
  } catch {
    return null;
  }
}

/**
 * Clear the service cache (useful for testing)
 */
export function clearServiceCache(): void {
  environmentServicesCache.clear();
}