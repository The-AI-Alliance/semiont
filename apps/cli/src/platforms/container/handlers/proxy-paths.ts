import * as path from 'path';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import { SemiontProject } from '@semiont/core/node';

export interface ContainerProxyPaths {
  configDir: string;          // Base directory for generated proxy config files
  configFile: string;         // Envoy configuration file
  logsDir: string;            // Directory for log files
  pidFile: string;            // Process ID file (unused for containers, kept for interface parity)
  containerLogFile: string;   // Container stdout/stderr log
  accessLogFile: string;      // Access log file
  adminLogFile: string;       // Admin interface log file
}

export function getProxyPaths<T>(context: BaseHandlerContext<T>): ContainerProxyPaths {
  const projectRoot = context.service.projectRoot;
  const project = new SemiontProject(projectRoot);
  const configDir = path.join(project.configDir, 'proxy');
  const logsDir = path.join(project.stateDir, 'proxy');

  return {
    configDir,
    configFile: path.join(configDir, 'envoy.yaml'),
    logsDir,
    pidFile: path.join(project.runtimeDir, 'proxy.pid'),
    containerLogFile: path.join(logsDir, 'container.log'),
    accessLogFile: path.join(logsDir, 'access.log'),
    adminLogFile: path.join(logsDir, 'admin.log'),
  };
}
