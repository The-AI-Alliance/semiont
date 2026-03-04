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

/**
 * Get the templates directory path.
 *
 * When bundled (esbuild → dist/cli.mjs), __dirname is the dist/ directory
 * and build.mjs copies templates/ → dist/templates/.
 *
 * When running from source (src/), we traverse up from __dirname to the
 * package root (apps/cli/) and then into templates/.
 *
 * @param importMetaUrl - pass `import.meta.url` from the calling module
 */
export function getTemplatesDir(importMetaUrl: string): string {
  const filename = fileURLToPath(importMetaUrl);
  const dirname = path.dirname(filename);

  if (dirname.includes(path.sep + 'src' + path.sep)) {
    // Running from source: find package root by looking for package.json
    let dir = dirname;
    while (dir !== path.dirname(dir)) {
      if (path.basename(dir) === 'src') {
        // src's parent is the package root (apps/cli)
        return path.join(path.dirname(dir), 'templates');
      }
      dir = path.dirname(dir);
    }
    // Fallback: shouldn't happen
    throw new Error(`Cannot locate templates directory from source path: ${dirname}`);
  }

  // Bundled: __dirname is dist/, templates are at dist/templates/
  return path.join(dirname, 'templates');
}