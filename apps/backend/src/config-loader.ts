/**
 * Configuration Loader for Backend
 *
 * Filesystem wrapper around @semiont/core's pure config functions.
 * This keeps fs operations out of the core package.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseAndMergeConfigs, ConfigurationError, type EnvironmentConfig } from '@semiont/core';

/**
 * Find project root from SEMIONT_ROOT environment variable
 */
export function findProjectRoot(): string {
  const root = process.env.SEMIONT_ROOT;

  if (!root) {
    throw new ConfigurationError(
      'SEMIONT_ROOT environment variable is not set',
      undefined,
      'Set SEMIONT_ROOT to your project directory'
    );
  }

  if (!fs.existsSync(root)) {
    throw new ConfigurationError(
      `SEMIONT_ROOT points to non-existent directory: ${root}`,
      undefined,
      'Check that SEMIONT_ROOT environment variable is set correctly'
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
