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
  
  // Determine if we're in dist/ (bundled) or src/ (development)
  const isDist = dirname.includes('/dist/') || dirname.includes('\\dist\\');
  
  // Adjust path calculation based on whether we're bundled or not
  let cliRoot: string;
  if (isDist) {
    // From dist/commands/ up to apps/cli
    cliRoot = path.resolve(dirname, '../..');
  } else {
    // From src/commands/ up to apps/cli  
    cliRoot = path.resolve(dirname, '../..');
  }
  
  // From apps/cli up to project root
  const projectRoot = path.resolve(cliRoot, '../..');
  
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