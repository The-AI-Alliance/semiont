import * as path from 'path';
import { ContainerProvisionHandlerContext } from './types.js';

/**
 * Get consistent paths for proxy service files and directories
 */
export function getProxyPaths(context: ContainerProvisionHandlerContext | any) {
  const projectRoot = context.service.projectRoot;

  // Runtime directory for proxy - directly in $SEMIONT_ROOT/proxy
  const runtimeDir = path.join(projectRoot, 'proxy');

  return {
    runtimeDir,
    logsDir: path.join(runtimeDir, 'logs'),
    pidFile: path.join(runtimeDir, 'proxy.pid'),
    configFile: path.join(runtimeDir, 'envoy.yaml'),
    containerLogFile: path.join(runtimeDir, 'logs', 'container.log'),
    accessLogFile: path.join(runtimeDir, 'logs', 'access.log'),
    adminLogFile: path.join(runtimeDir, 'logs', 'admin.log')
  };
}