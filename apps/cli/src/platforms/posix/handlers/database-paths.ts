import * as path from 'path';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import { SemiontProject } from '@semiont/core';

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
  const project = new SemiontProject(projectRoot);
  const runtimeDir = path.join(projectRoot, 'database');
  const dataDir = path.join(runtimeDir, 'data', context.service.name);
  const logsDir = path.join(project.stateDir, 'database');

  return {
    runtimeDir,
    pidFile: path.join(project.runtimeDir, 'database.pid'),
    logsDir,
    appLogFile: path.join(logsDir, 'app.log'),
    errorLogFile: path.join(logsDir, 'error.log'),
    dataDir,
  };
}
