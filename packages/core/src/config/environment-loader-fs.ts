/**
 * Filesystem-based wrapper for environment loading
 *
 * This module provides convenient filesystem-based wrappers around the pure
 * configuration functions. These are intended for application code that needs
 * to load config from disk.
 *
 * The pure functions (parseAndMergeConfigs, etc.) remain testable without
 * filesystem mocking.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseAndMergeConfigs, listEnvironmentNames, type EnvironmentConfig } from './environment-loader';
import { findProjectRoot } from './project-discovery';
import { ConfigurationError } from './configuration-error';

/**
 * Load environment configuration from filesystem
 * Convenience wrapper around parseAndMergeConfigs for application code
 *
 * @param projectRoot - Absolute path to project directory containing semiont.json
 * @param environment - Environment name (must match a file in environments/)
 * @returns Merged environment configuration
 * @throws ConfigurationError if files are missing or invalid
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

  // Use pure function with filesystem inputs
  return parseAndMergeConfigs(baseContent, envContent, process.env, environment, projectRoot);
}

/**
 * Get available environments by scanning environments directory
 * Convenience wrapper around listEnvironmentNames for application code
 *
 * @returns Array of environment names
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
 *
 * @param environment - Environment name to check
 * @returns True if environment exists
 */
export function isValidEnvironment(environment: string): boolean {
  return getAvailableEnvironments().includes(environment);
}
