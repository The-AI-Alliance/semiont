import { StateManager } from '../../../core/state-manager.js';
import * as fs from 'fs';
import { PosixCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { getMCPPaths } from './mcp-paths.js';

/**
 * Check handler for MCP (Model Context Protocol) services
 */
const checkMCPProcess = async (context: PosixCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service, savedState } = context;
  
  let status: 'running' | 'stopped' = 'stopped';
  let pid: number | undefined;
  let authStatus: 'configured' | 'not-configured' = 'not-configured';
  
  // Check if saved process is running
  if (savedState?.resources?.platform === 'posix' && 
      savedState.resources.data.pid && 
      StateManager.isProcessRunning(savedState.resources.data.pid)) {
    pid = savedState.resources.data.pid;
    status = 'running';
  }
  
  // Check MCP authentication status
  const paths = getMCPPaths(context);
  const { authFile: authPath } = paths;
  
  try {
    if (fs.existsSync(authPath)) {
      const authData = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      if (authData.refresh_token) {
        authStatus = 'configured';
      }
    }
  } catch {
    // Ignore auth check errors
  }
  
  const platformResources = pid ? {
    platform: 'posix' as const,
    data: { 
      pid,
      authPath
    }
  } : undefined;
  
  // Collect logs if running
  let logs: { recent: string[]; errors: string[] } | undefined = undefined;
  if (status === 'running' && platform && typeof platform.collectLogs === 'function') {
    const logEntries = await platform.collectLogs(service, { tail: 10 });
    if (logEntries) {
      logs = {
        recent: logEntries.map(entry => entry.message),
        errors: logEntries.filter(entry => entry.level === 'error').map(entry => entry.message)
      };
    }
  }
  
  return {
    success: true,
    status,
    platformResources,
    health: {
      healthy: status === 'running' && authStatus === 'configured',
      details: {
        processStatus: status,
        authStatus,
        message: status === 'running' 
          ? (authStatus === 'configured' ? 'MCP is running and authenticated' : 'MCP is running but not authenticated')
          : 'MCP is not running'
      }
    },
    logs,
    metadata: {
      serviceType: 'mcp',
      authPath,
      stateVerified: true
    }
  };
};

/**
 * Descriptor for POSIX MCP check handler
 */
export const mcpCheckDescriptor: HandlerDescriptor<PosixCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'mcp',
  handler: checkMCPProcess
};