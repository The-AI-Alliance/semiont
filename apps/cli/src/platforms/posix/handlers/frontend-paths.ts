import * as path from 'path';
import { createRequire } from 'module';

/**
 * Resolve the frontend npm package directory from an installed @semiont/frontend package.
 * Returns the package directory or null if not installed.
 */
export function resolveFrontendNpmPackage(projectRoot: string): string | null {
  try {
    const require = createRequire(path.join(projectRoot, 'node_modules', '.package.json'));
    const pkgPath = require.resolve('@semiont/frontend/package.json');
    return path.dirname(pkgPath);
  } catch {
    return null;
  }
}

/**
 * Resolve the path to the frontend server.js entry point.
 * Uses the package's `main` field (declared in package.publish.json) so the
 * path is derived from the manifest rather than hardcoded.
 * Returns null if not installed.
 */
export function resolveFrontendServerScript(projectRoot: string): string | null {
  try {
    const require = createRequire(path.join(projectRoot, 'node_modules', '.package.json'));
    // @semiont/frontend declares `"main": "server.js"` — resolve() follows it directly
    return require.resolve('@semiont/frontend');
  } catch {
    return null;
  }
}
