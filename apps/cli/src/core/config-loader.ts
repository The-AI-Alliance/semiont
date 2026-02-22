/**
 * Configuration Loader for CLI
 *
 * Filesystem wrapper around @semiont/core's pure config functions.
 * This keeps fs operations out of the core package.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createConfigLoader, listEnvironmentNames, ConfigurationError, type EnvironmentConfig, type ConfigFileReader } from '@semiont/core';

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
 * Node.js file reader implementation for CLI config loading
 */
const nodeFileReader: ConfigFileReader = {
  readIfExists: (filePath: string) => {
    const absolutePath = path.resolve(filePath);
    return fs.existsSync(absolutePath)
      ? fs.readFileSync(absolutePath, 'utf-8')
      : null;
  },

  readRequired: (filePath: string) => {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new ConfigurationError(
        `Configuration file not found: ${absolutePath}`,
        undefined,
        `Create the configuration file or use: semiont init`
      );
    }
    return fs.readFileSync(absolutePath, 'utf-8');
  },
};

/**
 * Load environment configuration from filesystem
 * Uses createConfigLoader from @semiont/core with Node.js file reader
 */
export const loadEnvironmentConfig = createConfigLoader(nodeFileReader);

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
