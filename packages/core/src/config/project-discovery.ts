/**
 * Project Discovery Module
 * 
 * Responsible for finding the Semiont project root directory.
 * Looks for semiont.json or environments directory to identify a valid project.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ConfigurationError } from './configuration-error';

/**
 * Find project root - returns SEMIONT_ROOT environment variable
 *
 * @returns The absolute path to the project root
 * @throws ConfigurationError if SEMIONT_ROOT is not set or invalid
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
  if (!isProjectRoot(root)) {
    throw new ConfigurationError(
      `SEMIONT_ROOT does not point to a valid Semiont project: ${root}`,
      undefined,
      'Ensure SEMIONT_ROOT points to a directory containing semiont.json or environments/'
    );
  }

  return root;
}

/**
 * Check if a path looks like a Semiont project root
 * 
 * @param projectPath - Path to check
 * @returns True if path contains semiont.json or environments directory
 */
export function isProjectRoot(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, 'semiont.json')) ||
         fs.existsSync(path.join(projectPath, 'environments'));
}

/**
 * Get the path to the environments directory
 * 
 * @param projectRoot - Project root directory (optional, will find if not provided)
 * @returns Path to environments directory
 */
export function getEnvironmentsPath(projectRoot?: string): string {
  const root = projectRoot || findProjectRoot();
  return path.join(root, 'environments');
}

/**
 * Get the path to semiont.json
 * 
 * @param projectRoot - Project root directory (optional, will find if not provided)
 * @returns Path to semiont.json
 */
export function getSemiontConfigPath(projectRoot?: string): string {
  const root = projectRoot || findProjectRoot();
  return path.join(root, 'semiont.json');
}