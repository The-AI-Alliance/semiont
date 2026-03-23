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
