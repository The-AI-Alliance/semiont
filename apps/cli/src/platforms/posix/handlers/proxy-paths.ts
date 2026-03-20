import * as path from 'path';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import { SemiontProject } from '@semiont/core';

/**
 * Proxy service paths on POSIX platform
 */
export interface ProxyPaths {
  runtimeDir: string;     // Base directory for proxy runtime files
  pidFile: string;        // Process ID file
  configFile: string;     // Envoy configuration file
  logsDir: string;        // Directory for log files
  appLogFile: string;     // Main proxy log file
  accessLogFile: string;  // Access log file
}

/**
 * Get all proxy paths for POSIX platform
 */
export function getProxyPaths<T>(context: BaseHandlerContext<T>): ProxyPaths {
  const projectRoot = context.service.projectRoot;
  const project = new SemiontProject(projectRoot);
  const runtimeDir = path.join(projectRoot, 'proxy');
  const logsDir = path.join(project.stateDir, 'proxy');

  return {
    runtimeDir,
    pidFile: path.join(project.runtimeDir, 'proxy.pid'),
    configFile: path.join(runtimeDir, 'envoy.yaml'),
    logsDir,
    appLogFile: path.join(logsDir, 'proxy.log'),
    accessLogFile: path.join(logsDir, 'access.log'),
  };
}
