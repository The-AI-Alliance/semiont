import * as path from 'path';
import { createRequire } from 'module';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';

/**
 * Frontend service paths on POSIX platform
 * All runtime files are stored in the source directory
 */
export interface FrontendPaths {
  sourceDir: string;      // Base directory for frontend source
  pidFile: string;        // Process ID file
  envLocalFile: string;   // Environment configuration file (.env.local for Next.js)
  logsDir: string;        // Directory for log files
  appLogFile: string;     // Application log file
  errorLogFile: string;   // Error log file
  tmpDir: string;         // Temporary files directory
  nextDir: string;        // Next.js build directory
  fromNpmPackage: boolean; // Whether source is an installed npm package
}

/**
 * Resolve the frontend source directory from an installed @semiont/frontend npm package.
 * Returns the package directory or null if not installed.
 */
export function resolveFrontendNpmPackage(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@semiont/frontend/package.json');
    return path.dirname(pkgPath);
  } catch {
    return null;
  }
}

/**
 * Get all frontend paths for POSIX platform.
 *
 * Resolution order:
 *   1. SEMIONT_REPO (if set) — developer mode, working on semiont source
 *   2. Installed @semiont/frontend npm package
 *   3. Fail with clear error
 */
export function getFrontendPaths<T>(context: BaseHandlerContext<T>): FrontendPaths {
  const semiontRepo = context.options?.semiontRepo;

  // 1. Explicit repo path (developer mode)
  if (semiontRepo) {
    const sourceDir = path.join(semiontRepo, 'apps', 'frontend');
    return buildPaths(sourceDir, false);
  }

  // 2. Installed npm package
  const npmDir = resolveFrontendNpmPackage();
  if (npmDir) {
    return buildPaths(npmDir, true);
  }

  // 3. Fail loudly
  throw new Error(
    'Cannot find frontend source. Either:\n' +
    '  - Set SEMIONT_REPO to your semiont clone, or\n' +
    '  - Run: npm install @semiont/frontend'
  );
}

function buildPaths(sourceDir: string, fromNpmPackage: boolean): FrontendPaths {
  return {
    sourceDir,
    pidFile: path.join(sourceDir, '.pid'),
    envLocalFile: path.join(sourceDir, '.env.local'),
    logsDir: path.join(sourceDir, 'logs'),
    appLogFile: path.join(sourceDir, 'logs', 'app.log'),
    errorLogFile: path.join(sourceDir, 'logs', 'error.log'),
    tmpDir: path.join(sourceDir, 'tmp'),
    nextDir: path.join(sourceDir, '.next'),
    fromNpmPackage,
  };
}
