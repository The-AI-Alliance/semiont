import * as path from 'path';
import { createRequire } from 'module';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import { SemiontProject } from '@semiont/core/node';

/**
 * Backend service paths on POSIX platform
 *
 * sourceDir: read-only code (npm package or SEMIONT_REPO checkout)
 * All runtime/log/pid paths come from SemiontProject.
 */
export interface BackendPaths {
  sourceDir: string;       // Base directory for backend source (read-only)
  pidFile: string;         // project.backendPidFile
  logsDir: string;         // project.backendLogsDir
  appLogFile: string;      // logsDir/app.log
  errorLogFile: string;    // logsDir/error.log
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
  const project = new SemiontProject(projectRoot);
  const semiontRepo = context.options?.semiontRepo;

  // 1. Explicit repo path (developer mode)
  if (semiontRepo) {
    return buildPaths(path.join(semiontRepo, 'apps', 'backend'), project, false);
  }

  // 2. Installed npm package
  const npmDir = resolveBackendNpmPackage(projectRoot);
  if (npmDir) {
    return buildPaths(npmDir, project, true);
  }

  // 3. Fail loudly
  throw new Error(
    'Cannot find backend source. Either:\n' +
    '  - Set SEMIONT_REPO to your semiont clone, or\n' +
    '  - Run: npm install @semiont/backend'
  );
}

function buildPaths(sourceDir: string, project: SemiontProject, fromNpmPackage: boolean): BackendPaths {
  return {
    sourceDir,
    pidFile:      project.backendPidFile,
    logsDir:      project.backendLogsDir,
    appLogFile:   path.join(project.backendLogsDir, 'app.log'),
    errorLogFile: path.join(project.backendLogsDir, 'error.log'),
    fromNpmPackage,
  };
}
