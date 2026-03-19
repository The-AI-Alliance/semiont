/**
 * Configuration Loader for CLI
 *
 * Filesystem wrapper around @semiont/core's pure config functions.
 * This keeps fs operations out of the core package.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createConfigLoader, listEnvironmentNames, ConfigurationError, readProjectName, type ConfigFileReader } from '@semiont/core';

export { readProjectName };

/**
 * Find project root by walking up from cwd looking for .semiont/.
 * SEMIONT_ROOT, if set, is used as an explicit override (analogous to GIT_DIR).
 */
export function findProjectRoot(): string {
  // Explicit override — skip the walk
  const override = process.env.SEMIONT_ROOT;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new ConfigurationError(
        `SEMIONT_ROOT points to non-existent directory: ${override}`,
        undefined,
        'Check that SEMIONT_ROOT is set correctly'
      );
    }
    if (!fs.existsSync(path.join(override, '.semiont'))) {
      throw new ConfigurationError(
        `SEMIONT_ROOT does not contain a .semiont/ directory: ${override}`,
        undefined,
        'Run: semiont init'
      );
    }
    return override;
  }

  // Walk up from cwd (analogous to git's .git/ discovery)
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, '.semiont'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  throw new ConfigurationError(
    'No .semiont/ directory found in current directory or any parent',
    undefined,
    'Run: semiont init'
  );
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

/**
 * Read the project name from .semiont/config ([project] name = "...").
 * Falls back to the basename of projectRoot if the file is absent or has no name key.
 */
