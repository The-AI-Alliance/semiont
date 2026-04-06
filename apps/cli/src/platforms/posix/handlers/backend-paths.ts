import * as path from 'path';
import { createRequire } from 'module';

/**
 * Resolve the backend npm package directory from an installed @semiont/backend package.
 * Returns the package directory or null if not installed.
 */
export function resolveBackendNpmPackage(installPrefix: string): string | null {
  try {
    const require = createRequire(path.join(installPrefix, 'node_modules', '.package.json'));
    const pkgPath = require.resolve('@semiont/backend/package.json');
    return path.dirname(pkgPath);
  } catch {
    return null;
  }
}

/**
 * Resolve the path to the backend entry point (dist/index.js).
 * Uses the package's `main` field (declared in package.publish.json) so the
 * path is derived from the manifest rather than hardcoded.
 * Returns null if not installed.
 */
export function resolveBackendEntryPoint(installPrefix: string): string | null {
  try {
    const require = createRequire(path.join(installPrefix, 'node_modules', '.package.json'));
    // @semiont/backend declares `"main": "dist/index.js"` — resolve() follows it directly
    return require.resolve('@semiont/backend');
  } catch {
    return null;
  }
}
