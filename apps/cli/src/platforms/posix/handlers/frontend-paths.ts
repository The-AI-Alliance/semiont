import * as path from 'path';
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
}

/**
 * Get all frontend paths for POSIX platform
 */
export function getFrontendPaths<T>(context: BaseHandlerContext<T>): FrontendPaths {
  const semiontRepo = context.options?.semiontRepo || process.env.SEMIONT_REPO;
  if (!semiontRepo) {
    throw new Error('SEMIONT_REPO not configured');
  }

  const sourceDir = path.join(semiontRepo, 'apps', 'frontend');

  return {
    sourceDir,
    pidFile: path.join(sourceDir, '.pid'),
    envLocalFile: path.join(sourceDir, '.env.local'),  // Frontend uses .env.local
    logsDir: path.join(sourceDir, 'logs'),
    appLogFile: path.join(sourceDir, 'logs', 'app.log'),
    errorLogFile: path.join(sourceDir, 'logs', 'error.log'),
    tmpDir: path.join(sourceDir, 'tmp'),
    nextDir: path.join(sourceDir, '.next')
  };
}