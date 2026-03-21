import * as path from 'path';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import { SemiontProject } from '@semiont/core/node';

export interface DatabasePaths {
  pidFile: string;        // Process ID file
  logsDir: string;        // Directory for log files
  appLogFile: string;     // Application log file
  errorLogFile: string;   // Error log file
  dataDir: string;        // Data storage directory
}

/**
 * Get all database paths for POSIX platform
 */
export function getDatabasePaths<T>(context: BaseHandlerContext<T>): DatabasePaths {
  const projectRoot = context.service.projectRoot;
  const project = new SemiontProject(projectRoot);
  const config = context.service.config as { dataDir?: string };
  const dataDir = config.dataDir
    ?? path.join(project.dataHome, 'database', context.service.name);
  const logsDir = path.join(project.stateDir, 'database');

  return {
    pidFile: path.join(project.runtimeDir, 'database.pid'),
    logsDir,
    appLogFile: path.join(logsDir, 'app.log'),
    errorLogFile: path.join(logsDir, 'error.log'),
    dataDir,
  };
}
