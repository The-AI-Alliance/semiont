import * as path from 'path';
import { createRequire } from 'module';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import { SemiontProject } from '@semiont/core/node';

/**
 * Frontend service paths on POSIX platform
 *
 * sourceDir: read-only code from the installed @semiont/frontend npm package
 * All runtime/log/pid paths come from SemiontProject.
 */
export interface FrontendPaths {
  project: SemiontProject; // Canonical project paths (XDG-derived)
  sourceDir: string;       // Base directory for frontend source (read-only, from npm package)
  pidFile: string;         // project.frontendPidFile
  logsDir: string;         // project.frontendLogsDir
  appLogFile: string;      // logsDir/app.log
  errorLogFile: string;    // logsDir/error.log
  nextDir: string;         // Next.js build directory (in sourceDir)
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
 * Source: installed @semiont/frontend npm package.
 * Runtime files always go to XDG state dir (via SemiontProject).
 */
export function getFrontendPaths<T>(context: BaseHandlerContext<T>): FrontendPaths {
  const projectRoot = context.service.projectRoot;
  const project = new SemiontProject(projectRoot);

  const npmDir = resolveFrontendNpmPackage(projectRoot);
  if (!npmDir) {
    throw new Error(
      'Cannot find frontend source. Run: npm install @semiont/frontend'
    );
  }

  return {
    project,
    sourceDir:    npmDir,
    pidFile:      project.frontendPidFile,
    logsDir:      project.frontendLogsDir,
    appLogFile:   path.join(project.frontendLogsDir, 'app.log'),
    errorLogFile: path.join(project.frontendLogsDir, 'error.log'),
    nextDir:      path.join(npmDir, '.next'),
  };
}
