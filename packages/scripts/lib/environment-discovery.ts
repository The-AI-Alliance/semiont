/**
 * Environment Discovery Utility
 * 
 * Automatically discovers available environments from the config directory
 */

import * as fs from 'fs';
import * as path from 'path';
import { findProjectRoot } from '@semiont/config-loader';

export interface EnvironmentInfo {
  name: string;
  isLocal: boolean;
  isCloud: boolean;
}

/**
 * Discover available environments by scanning config/environments directory
 */
export function discoverEnvironments(): EnvironmentInfo[] {
  const projectRoot = findProjectRoot();
  const configDir = path.join(projectRoot, 'config', 'environments');
  
  if (!fs.existsSync(configDir)) {
    console.warn(`Config directory not found: ${configDir}`);
    return [];
  }
  
  const files = fs.readdirSync(configDir);
  const environments: EnvironmentInfo[] = [];
  
  for (const file of files) {
    if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
      const name = path.basename(file, '.ts');
      const isLocal = name === 'local';
      const isCloud = !isLocal && name !== 'test' && name !== 'unit' && name !== 'integration';
      
      environments.push({
        name,
        isLocal,
        isCloud
      });
    }
  }
  
  // Sort: local first, then cloud environments alphabetically, then test environments
  return environments.sort((a, b) => {
    if (a.isLocal && !b.isLocal) return -1;
    if (!a.isLocal && b.isLocal) return 1;
    if (a.isCloud && !b.isCloud) return -1;
    if (!a.isCloud && b.isCloud) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Get all environment names
 */
export function getAvailableEnvironments(): string[] {
  return discoverEnvironments().map(env => env.name);
}

/**
 * Get only cloud environments (excludes local, test, unit, integration)
 */
export function getCloudEnvironments(): string[] {
  return discoverEnvironments()
    .filter(env => env.isCloud)
    .map(env => env.name);
}

/**
 * Check if an environment exists
 */
export function isValidEnvironment(environment: string): boolean {
  return getAvailableEnvironments().includes(environment);
}

/**
 * Check if an environment is a cloud environment
 */
export function isCloudEnvironment(environment: string): boolean {
  return getCloudEnvironments().includes(environment);
}