import { StateManager } from '../../../core/state-manager.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { execSync } from 'child_process';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';

/**
 * Check handler for POSIX web services
 */
const checkWebProcess = async (context: CheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service } = context;
  const requirements = service.getRequirements();
  
  // Load saved state
  const savedState = await StateManager.load(
    service.projectRoot,
    service.environment,
    service.name
  );
  
  let status: 'running' | 'stopped' | 'unhealthy' = 'stopped';
  let pid: number | undefined;
  let health: any = undefined;
  
  // Check if saved process is running
  if (savedState?.resources?.platform === 'posix' && 
      savedState.resources.data.pid && 
      StateManager.isProcessRunning(savedState.resources.data.pid)) {
    pid = savedState.resources.data.pid;
    status = 'running';
  } else {
    // Try to find process by port from requirements
    const port = requirements.network?.ports?.[0];
    if (port && await isPortInUse(port)) {
      // Try to find the PID using the port
      try {
        const output = process.platform === 'darwin'
          ? execSync(`lsof -ti:${port}`, { encoding: 'utf-8' })
          : execSync(`fuser ${port}/tcp 2>/dev/null | awk '{print $2}'`, { encoding: 'utf-8' });
        
        const foundPid = parseInt(output.trim());
        if (!isNaN(foundPid)) {
          pid = foundPid;
          status = 'running';
        } else {
          status = 'running';
          // Port is in use but we couldn't determine the PID
        }
      } catch {
        status = 'running';
        // Port is in use but we couldn't determine the PID
      }
    }
  }
  
  // Collect logs if running
  let logs = undefined;
  if (status === 'running' && platform && typeof platform.collectLogs === 'function') {
    const logEntries = await platform.collectLogs(service, { tail: 10 });
    logs = logEntries;
  }
  
  // Perform health check for web services
  if (status === 'running' && requirements.network?.healthCheckPath) {
    const port = requirements.network?.healthCheckPort || requirements.network?.ports?.[0] || 3000;
    const healthUrl = `http://localhost:${port}${requirements.network.healthCheckPath}`;
    
    try {
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      
      health = {
        endpoint: healthUrl,
        statusCode: response.status,
        healthy: response.ok,
        details: { status: response.ok ? 'healthy' : 'unhealthy' }
      };
      
      if (!response.ok) {
        status = 'unhealthy';
      }
    } catch (error) {
      status = 'unhealthy';
      health = {
        endpoint: healthUrl,
        healthy: false,
        details: { error: error instanceof Error ? error.message : 'Health check failed' }
      };
    }
  }
  
  const platformResources = pid ? {
    platform: 'posix' as const,
    data: {
      pid,
      port: requirements.network?.ports?.[0]
    }
  } : undefined;
  
  return {
    success: true,
    status,
    platformResources,
    health,
    logs,
    metadata: {
      serviceType: 'web',
      stateVerified: true
    }
  };
};

/**
 * Descriptor for POSIX web check handler
 */
export const webCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'web',
  handler: checkWebProcess
};