import * as path from 'path';
import { createRequire } from 'module';

/**
 * Resolve the backend npm package directory from an installed @semiont/backend package.
 * Returns the package directory or null if not installed.
 */
export function resolveBackendNpmPackage(projectRoot: string): string | null {
  try {
    const require = createRequire(path.join(projectRoot, 'node_modules', '.package.json'));
    const pkgPath = require.resolve('@semiont/backend/package.json');
    return path.dirname(pkgPath);
  } catch {
    return null;
  }
}
