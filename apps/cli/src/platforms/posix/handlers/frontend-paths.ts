import * as path from 'path';
import { createRequire } from 'module';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import { SemiontProject } from '@semiont/core';

/**
 * Frontend service paths on POSIX platform
 *
 * sourceDir: read-only code (npm package or SEMIONT_REPO checkout)
 * runtimeDir: read-write state under $SEMIONT_ROOT/frontend/
 */
export interface FrontendPaths {
  sourceDir: string;      // Base directory for frontend source (read-only)
  runtimeDir: string;     // Base directory for runtime state (read-write)
  pidFile: string;        // Process ID file (in runtimeDir)
  logsDir: string;        // Directory for log files (in runtimeDir)
  appLogFile: string;     // Application log file (in runtimeDir)
  errorLogFile: string;   // Error log file (in runtimeDir)
  nextDir: string;        // Next.js build directory (in sourceDir)
  fromNpmPackage: boolean; // Whether source is an installed npm package
}

/**
 * Resolve the frontend source directory from an installed @semiont/frontend npm package.
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
 * Get all frontend paths for POSIX platform.
 *
 * Source resolution order:
 *   1. SEMIONT_REPO (if set) — developer mode, working on semiont source
 *   2. Installed @semiont/frontend npm package
 *   3. Fail with clear error
 *
 * Runtime files always go to $SEMIONT_ROOT/frontend/ (following proxy-paths.ts pattern).
 */
export function getFrontendPaths<T>(context: BaseHandlerContext<T>): FrontendPaths {
  const projectRoot = context.service.projectRoot;
  const project = new SemiontProject(projectRoot);
  const runtimeDir = path.join(projectRoot, 'frontend');
  const semiontRepo = context.options?.semiontRepo;

  // 1. Explicit repo path (developer mode)
  if (semiontRepo) {
    const sourceDir = path.join(semiontRepo, 'apps', 'frontend');
    return buildPaths(sourceDir, runtimeDir, project, false);
  }

  // 2. Installed npm package
  const npmDir = resolveFrontendNpmPackage(projectRoot);
  if (npmDir) {
    return buildPaths(npmDir, runtimeDir, project, true);
  }

  // 3. Fail loudly
  throw new Error(
    'Cannot find frontend source. Either:\n' +
    '  - Set SEMIONT_REPO to your semiont clone, or\n' +
    '  - Run: npm install @semiont/frontend'
  );
}

function buildPaths(sourceDir: string, runtimeDir: string, project: SemiontProject, fromNpmPackage: boolean): FrontendPaths {
  const logsDir = path.join(project.stateDir, 'frontend');
  return {
    sourceDir,
    runtimeDir,
    pidFile: path.join(project.runtimeDir, 'frontend.pid'),
    logsDir,
    appLogFile: path.join(logsDir, 'app.log'),
    errorLogFile: path.join(logsDir, 'error.log'),
    nextDir: path.join(sourceDir, '.next'),
    fromNpmPackage,
  };
}
