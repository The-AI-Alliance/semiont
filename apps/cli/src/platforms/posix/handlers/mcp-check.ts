import { CheckHandlerResult } from '../../../core/handlers/types.js';
import { StateManager } from '../../../core/state-manager.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Check handler for MCP (Model Context Protocol) services
 */
export async function checkMCPProcess(context: any): Promise<CheckHandlerResult> {
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
    logs = await platform.collectLogs(service);
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
}