/**
 * Configuration Loader for CLI
 *
 * Filesystem wrapper around @semiont/core's pure config functions.
 * This keeps fs operations out of the core package.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseAndMergeConfigs, listEnvironmentNames, ConfigurationError, type EnvironmentConfig } from '@semiont/core';

/**
 * Find project root from SEMIONT_ROOT environment variable
 */
export function findProjectRoot(): string {
  const root = process.env.SEMIONT_ROOT;

  if (!root) {
    throw new ConfigurationError(
      'SEMIONT_ROOT environment variable is not set',
      undefined,
      'Set SEMIONT_ROOT to your project directory, or use the semiont CLI which sets it automatically'
    );
  }

  if (!fs.existsSync(root)) {
    throw new ConfigurationError(
      `SEMIONT_ROOT points to non-existent directory: ${root}`,
      undefined,
      'Check that SEMIONT_ROOT environment variable is set correctly'
    );
  }

  // Verify it's a valid project root
  const hasSemiontJson = fs.existsSync(path.join(root, 'semiont.json'));
  const hasEnvironments = fs.existsSync(path.join(root, 'environments'));

  if (!hasSemiontJson && !hasEnvironments) {
    throw new ConfigurationError(
      `SEMIONT_ROOT does not point to a valid Semiont project: ${root}`,
      undefined,
      'Ensure SEMIONT_ROOT points to a directory containing semiont.json or environments/'
    );
  }

  return root;
}

/**
 * Load environment configuration from filesystem
 */
export function loadEnvironmentConfig(projectRoot: string, environment: string): EnvironmentConfig {
  // Load base semiont.json
  const baseConfigPath = path.join(projectRoot, 'semiont.json');
  const baseContent = fs.existsSync(baseConfigPath)
    ? fs.readFileSync(baseConfigPath, 'utf-8')
    : null;

  // Load environment-specific config
  const envPath = path.join(projectRoot, 'environments', `${environment}.json`);
  if (!fs.existsSync(envPath)) {
    throw new ConfigurationError(
      `Environment configuration missing: ${envPath}`,
      environment,
      `Create the configuration file or use: semiont init`
    );
  }

  const envContent = fs.readFileSync(envPath, 'utf-8');

  // Use pure function from @semiont/core with filesystem inputs
  return parseAndMergeConfigs(baseContent, envContent, process.env, environment, projectRoot);
}

/**
 * Get available environments by scanning environments directory
 */
export function getAvailableEnvironments(): string[] {
  try {
    const projectRoot = findProjectRoot();
    const configDir = path.join(projectRoot, 'environments');

    if (!fs.existsSync(configDir)) {
      return [];
    }

    const files = fs.readdirSync(configDir);
    return listEnvironmentNames(files);
  } catch (error) {
    return [];
  }
}

/**
 * Check if an environment exists
 */
export function isValidEnvironment(environment: string): boolean {
  return getAvailableEnvironments().includes(environment);
}
