import * as path from 'path';
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
}

/**
 * Get all backend paths for POSIX platform
 */
export function getBackendPaths<T>(context: BaseHandlerContext<T>): BackendPaths {
  const semiontRepo = context.options?.semiontRepo || process.env.SEMIONT_REPO;
  if (!semiontRepo) {
    throw new Error('SEMIONT_REPO not configured');
  }

  const sourceDir = path.join(semiontRepo, 'apps', 'backend');

  return {
    sourceDir,
    pidFile: path.join(sourceDir, '.pid'),
    envFile: path.join(sourceDir, '.env'),
    logsDir: path.join(sourceDir, 'logs'),
    appLogFile: path.join(sourceDir, 'logs', 'app.log'),
    errorLogFile: path.join(sourceDir, 'logs', 'error.log'),
    tmpDir: path.join(sourceDir, 'tmp'),
    distDir: path.join(sourceDir, 'dist')
  };
}