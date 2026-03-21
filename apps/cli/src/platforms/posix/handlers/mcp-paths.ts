import * as os from 'os';
import * as path from 'path';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import { SemiontProject } from '@semiont/core/node';

/**
 * MCP service paths on POSIX platform
 * Paths are in user home directory
 */
export interface MCPPaths {
  configDir: string;      // ~/.config/semiont directory
  pidFile: string;        // Process ID file (in configDir)
  authFile: string;       // MCP auth JSON file per environment
}

/**
 * Get all MCP paths for POSIX platform
 */
export function getMCPPaths<T>(context: BaseHandlerContext<T>): MCPPaths {
  const service = context.service;
  const project = new SemiontProject(service.projectRoot);

  const configDir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'semiont'
  );

  const authFile = path.join(
    configDir,
    `mcp-auth-${service.environment}.json`
  );

  return {
    configDir,
    pidFile: path.join(project.runtimeDir, 'mcp.pid'),
    authFile
  };
}
