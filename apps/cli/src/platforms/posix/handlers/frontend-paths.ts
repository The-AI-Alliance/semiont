import * as path from 'path';
import { createRequire } from 'module';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import { SemiontProject } from '@semiont/core/node';

/**
 * Frontend service paths on POSIX platform
 *
 * sourceDir: read-only code (npm package or SEMIONT_REPO checkout)
 * All runtime/log/pid paths come from SemiontProject.
 */
export interface FrontendPaths {
  sourceDir: string;       // Base directory for frontend source (read-only)
  pidFile: string;         // project.frontendPidFile
  logsDir: string;         // project.frontendLogsDir
  appLogFile: string;      // logsDir/app.log
  errorLogFile: string;    // logsDir/error.log
  nextDir: string;         // Next.js build directory (in sourceDir)
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
  const semiontRepo = context.options?.semiontRepo;

  // 1. Explicit repo path (developer mode)
  if (semiontRepo) {
    return buildPaths(path.join(semiontRepo, 'apps', 'frontend'), project, false);
  }

  // 2. Installed npm package
  const npmDir = resolveFrontendNpmPackage(projectRoot);
  if (npmDir) {
    return buildPaths(npmDir, project, true);
  }

  // 3. Fail loudly
  throw new Error(
    'Cannot find frontend source. Either:\n' +
    '  - Set SEMIONT_REPO to your semiont clone, or\n' +
    '  - Run: npm install @semiont/frontend'
  );
}

function buildPaths(sourceDir: string, project: SemiontProject, fromNpmPackage: boolean): FrontendPaths {
  return {
    sourceDir,
    pidFile:      project.frontendPidFile,
    logsDir:      project.frontendLogsDir,
    appLogFile:   path.join(project.frontendLogsDir, 'app.log'),
    errorLogFile: path.join(project.frontendLogsDir, 'error.log'),
    nextDir:      path.join(sourceDir, '.next'),
    fromNpmPackage,
  };
}
