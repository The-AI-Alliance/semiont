import * as path from 'path';
import { createRequire } from 'module';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import { SemiontProject } from '@semiont/core/node';

/**
 * Backend service paths on POSIX platform
 *
 * sourceDir: read-only code from the installed @semiont/backend npm package
 * All runtime/log/pid paths come from SemiontProject.
 */
export interface BackendPaths {
  project: SemiontProject; // Canonical project paths (XDG-derived)
  sourceDir: string;       // Base directory for backend source (read-only, from npm package)
  pidFile: string;         // project.backendPidFile
  logsDir: string;         // project.backendLogsDir
  appLogFile: string;      // logsDir/app.log
  errorLogFile: string;    // logsDir/error.log
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
 * Source: installed @semiont/backend npm package.
 * Runtime files always go to XDG state dir (via SemiontProject).
 */
export function getBackendPaths<T>(context: BaseHandlerContext<T>): BackendPaths {
  const projectRoot = context.service.projectRoot;
  const project = new SemiontProject(projectRoot);

  const npmDir = resolveBackendNpmPackage(projectRoot);
  if (!npmDir) {
    throw new Error(
      'Cannot find backend source. Run: npm install @semiont/backend'
    );
  }

  return {
    project,
    sourceDir:    npmDir,
    pidFile:      project.backendPidFile,
    logsDir:      project.backendLogsDir,
    appLogFile:   path.join(project.backendLogsDir, 'app.log'),
    errorLogFile: path.join(project.backendLogsDir, 'error.log'),
  };
}
