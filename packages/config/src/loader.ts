import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { EnvironmentConfig, EnvironmentConfigSchema } from './types.js';

/**
 * Find the project root by looking for semiont.json
 */
export function findProjectRoot(startPath: string = process.cwd()): string | null {
  let currentPath = resolve(startPath);
  const root = resolve('/');
  
  while (currentPath !== root) {
    if (existsSync(join(currentPath, 'semiont.json'))) {
      return currentPath;
    }
    currentPath = resolve(currentPath, '..');
  }
  
  // Also check root directory
  if (existsSync(join(root, 'semiont.json'))) {
    return root;
  }
  
  return null;
}

/**
 * Load environment configuration from file
 */
export function loadEnvironmentConfig(
  environmentName: string,
  projectRoot?: string
): EnvironmentConfig {
  const root = projectRoot || findProjectRoot();
  
  if (!root) {
    throw new Error('Could not find project root (no semiont.json found)');
  }
  
  const envPath = join(root, 'environments', `${environmentName}.json`);
  
  if (!existsSync(envPath)) {
    throw new Error(`Environment configuration not found: ${envPath}`);
  }
  
  try {
    const content = readFileSync(envPath, 'utf-8');
    const data = JSON.parse(content);
    
    // Validate against schema
    const result = EnvironmentConfigSchema.safeParse(data);
    
    if (!result.success) {
      throw new Error(`Invalid environment configuration: ${result.error.message}`);
    }
    
    return result.data;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load environment '${environmentName}': ${error.message}`);
    }
    throw error;
  }
}

/**
 * Get list of available environments
 */
export function getAvailableEnvironments(projectRoot?: string): string[] {
  const root = projectRoot || findProjectRoot();
  
  if (!root) {
    return [];
  }
  
  const envDir = join(root, 'environments');
  
  if (!existsSync(envDir)) {
    return [];
  }
  
  try {
    const files = readdirSync(envDir);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/**
 * Check if an environment exists
 */
export function isValidEnvironment(
  environmentName: string,
  projectRoot?: string
): boolean {
  return getAvailableEnvironments(projectRoot).includes(environmentName);
}