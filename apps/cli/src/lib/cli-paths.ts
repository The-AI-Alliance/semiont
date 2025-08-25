/**
 * Shared path resolution utilities for CLI commands
 */

import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Get standardized paths for CLI commands
 */
export function getCliPaths(importMetaUrl: string) {
  const filename = fileURLToPath(importMetaUrl);
  const dirname = path.dirname(filename);
  
  // From commands/ subdirectory, go up to apps/cli, then up to project root
  const cliRoot = path.resolve(dirname, '../..');  // up from src/commands to apps/cli
  const projectRoot = path.resolve(cliRoot, '../..');  // up from apps/cli to project root
  
  return {
    filename,
    dirname,
    cliRoot,
    projectRoot,
  };
}

/**
 * Get project root from any CLI file
 */
export function getProjectRoot(importMetaUrl: string): string {
  return getCliPaths(importMetaUrl).projectRoot;
}

/**
 * Get CLI package root from any CLI file  
 */
export function getCliRoot(importMetaUrl: string): string {
  return getCliPaths(importMetaUrl).cliRoot;
}