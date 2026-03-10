import * as path from 'path';
import { createRequire } from 'module';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';

/**
 * Backend service paths on POSIX platform
 *
 * sourceDir: read-only code (npm package or SEMIONT_REPO checkout)
 * runtimeDir: read-write state under $SEMIONT_ROOT/backend/
 */
export interface BackendPaths {
  sourceDir: string;      // Base directory for backend source (read-only)
  runtimeDir: string;     // Base directory for runtime state (read-write)
  pidFile: string;        // Process ID file (in runtimeDir)
  envFile: string;        // Environment configuration file (in runtimeDir)
  logsDir: string;        // Directory for log files (in runtimeDir)
  appLogFile: string;     // Application log file (in runtimeDir)
  errorLogFile: string;   // Error log file (in runtimeDir)
  tmpDir: string;         // Temporary files directory (in runtimeDir)
  distDir: string;        // Compiled distribution directory (in sourceDir)
  fromNpmPackage: boolean; // Whether source is an installed npm package
}

/**
 * Resolve the backend source directory from an installed @semiont/backend npm package.
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

/**
 * Get all backend paths for POSIX platform.
 *
 * Source resolution order:
 *   1. SEMIONT_REPO (if set) — developer mode, working on semiont source
 *   2. Installed @semiont/backend npm package
 *   3. Fail with clear error
 *
 * Runtime files always go to $SEMIONT_ROOT/backend/ (following proxy-paths.ts pattern).
 */
export function getBackendPaths<T>(context: BaseHandlerContext<T>): BackendPaths {
  const projectRoot = context.service.projectRoot;
  const runtimeDir = path.join(projectRoot, 'backend');
  const semiontRepo = context.options?.semiontRepo;

  // 1. Explicit repo path (developer mode)
  if (semiontRepo) {
    const sourceDir = path.join(semiontRepo, 'apps', 'backend');
    return buildPaths(sourceDir, runtimeDir, false);
  }

  // 2. Installed npm package
  const npmDir = resolveBackendNpmPackage(projectRoot);
  if (npmDir) {
    return buildPaths(npmDir, runtimeDir, true);
  }

  // 3. Fail loudly
  throw new Error(
    'Cannot find backend source. Either:\n' +
    '  - Set SEMIONT_REPO to your semiont clone, or\n' +
    '  - Run: npm install @semiont/backend'
  );
}

function buildPaths(sourceDir: string, runtimeDir: string, fromNpmPackage: boolean): BackendPaths {
  return {
    sourceDir,
    runtimeDir,
    pidFile: path.join(runtimeDir, 'backend.pid'),
    envFile: path.join(runtimeDir, '.env'),
    logsDir: path.join(runtimeDir, 'logs'),
    appLogFile: path.join(runtimeDir, 'logs', 'app.log'),
    errorLogFile: path.join(runtimeDir, 'logs', 'error.log'),
    tmpDir: path.join(runtimeDir, 'tmp'),
    distDir: path.join(sourceDir, 'dist'),
    fromNpmPackage,
  };
}
