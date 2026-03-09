import * as path from 'path';
import { createRequire } from 'module';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';

/**
 * Backend service paths on POSIX platform
 * All runtime files are stored in the source directory
 */
export interface BackendPaths {
  sourceDir: string;      // Base directory for backend source
  pidFile: string;        // Process ID file
  envFile: string;        // Environment configuration file (.env)
  logsDir: string;        // Directory for log files
  appLogFile: string;     // Application log file
  errorLogFile: string;   // Error log file
  tmpDir: string;         // Temporary files directory
  distDir: string;        // Compiled distribution directory
  fromNpmPackage: boolean; // Whether source is an installed npm package
}

/**
 * Resolve the backend source directory from an installed @semiont/backend npm package.
 * Returns the package directory or null if not installed.
 */
export function resolveBackendNpmPackage(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@semiont/backend/package.json');
    return path.dirname(pkgPath);
  } catch {
    return null;
  }
}

/**
 * Get all backend paths for POSIX platform.
 *
 * Resolution order:
 *   1. SEMIONT_REPO (if set) — developer mode, working on semiont source
 *   2. Installed @semiont/backend npm package
 *   3. Fail with clear error
 */
export function getBackendPaths<T>(context: BaseHandlerContext<T>): BackendPaths {
  const semiontRepo = context.options?.semiontRepo;

  // 1. Explicit repo path (developer mode)
  if (semiontRepo) {
    const sourceDir = path.join(semiontRepo, 'apps', 'backend');
    return buildPaths(sourceDir, false);
  }

  // 2. Installed npm package
  const npmDir = resolveBackendNpmPackage();
  if (npmDir) {
    return buildPaths(npmDir, true);
  }

  // 3. Fail loudly
  throw new Error(
    'Cannot find backend source. Either:\n' +
    '  - Set SEMIONT_REPO to your semiont clone, or\n' +
    '  - Run: npm install @semiont/backend'
  );
}

function buildPaths(sourceDir: string, fromNpmPackage: boolean): BackendPaths {
  return {
    sourceDir,
    pidFile: path.join(sourceDir, '.pid'),
    envFile: path.join(sourceDir, '.env'),
    logsDir: path.join(sourceDir, 'logs'),
    appLogFile: path.join(sourceDir, 'logs', 'app.log'),
    errorLogFile: path.join(sourceDir, 'logs', 'error.log'),
    tmpDir: path.join(sourceDir, 'tmp'),
    distDir: path.join(sourceDir, 'dist'),
    fromNpmPackage,
  };
}