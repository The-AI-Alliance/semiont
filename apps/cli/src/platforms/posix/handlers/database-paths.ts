import * as path from 'path';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';

/**
 * Database service paths on POSIX platform
 *
 * runtimeDir: read-write state under $SEMIONT_ROOT/database/
 */
export interface DatabasePaths {
  runtimeDir: string;     // Base directory for runtime state (read-write)
  pidFile: string;        // Process ID file (in runtimeDir)
  logsDir: string;        // Directory for log files (in runtimeDir)
  appLogFile: string;     // Application log file (in runtimeDir)
  errorLogFile: string;   // Error log file (in runtimeDir)
  dataDir: string;        // Data storage directory
}

/**
 * Get all database paths for POSIX platform
 */
export function getDatabasePaths<T>(context: BaseHandlerContext<T>): DatabasePaths {
  const projectRoot = context.service.projectRoot;
  const runtimeDir = path.join(projectRoot, 'database');
  const dataDir = path.join(runtimeDir, 'data', context.service.name);

  return {
    runtimeDir,
    pidFile: path.join(runtimeDir, 'database.pid'),
    logsDir: path.join(runtimeDir, 'logs'),
    appLogFile: path.join(runtimeDir, 'logs', 'app.log'),
    errorLogFile: path.join(runtimeDir, 'logs', 'error.log'),
    dataDir,
  };
}
