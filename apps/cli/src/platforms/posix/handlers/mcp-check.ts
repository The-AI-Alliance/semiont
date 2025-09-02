import { StateManager } from '../../../core/state-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';

/**
 * Check handler for MCP (Model Context Protocol) services
 */
const checkMCPProcess = async (context: CheckHandlerContext): Promise<CheckHandlerResult> => {
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
  const configDir = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.config',
    'semiont'
  );
  const authPath = path.join(configDir, `mcp-auth-${service.environment}.json`);
  
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
  let logs = undefined;
  if (status === 'running' && platform && typeof platform.collectLogs === 'function') {
    const logEntries = await platform.collectLogs(service, { tail: 10 });
    logs = logEntries;
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
export const mcpCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'mcp',
  handler: checkMCPProcess
};