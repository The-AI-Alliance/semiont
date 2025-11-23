import * as path from 'path';
import * as os from 'os';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';

/**
 * MCP service paths on POSIX platform
 * Paths are in user home directory
 */
export interface MCPPaths {
  configDir: string;      // ~/.config/semiont directory
  authFile: string;       // MCP auth JSON file per environment
}

/**
 * Get all MCP paths for POSIX platform
 */
export function getMCPPaths<T>(context: BaseHandlerContext<T>): MCPPaths {
  const service = context.service;

  const configDir = path.join(
    os.homedir(),
    '.config',
    'semiont'
  );

  const authFile = path.join(
    configDir,
    `mcp-auth-${service.environment}.json`
  );

  return {
    configDir,
    authFile
  };
}