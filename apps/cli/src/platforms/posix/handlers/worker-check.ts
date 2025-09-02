import { StateManager } from '../../../core/state-manager.js';
import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';

/**
 * Check handler for POSIX worker/background services
 */
const checkWorkerProcess = async (context: CheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service, savedState } = context;
  
  let status: 'running' | 'stopped' = 'stopped';
  let pid: number | undefined;
  
  // Check if saved process is running
  if (savedState?.resources?.platform === 'posix' && 
      savedState.resources.data.pid && 
      StateManager.isProcessRunning(savedState.resources.data.pid)) {
    pid = savedState.resources.data.pid;
    status = 'running';
  }
  
  // Workers typically don't have health endpoints or ports
  // We can only check if the process is alive
  
  const platformResources = pid ? {
    platform: 'posix' as const,
    data: { pid }
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
      healthy: status === 'running',
      details: {
        message: status === 'running' ? 'Process is running' : 'Process is not running'
      }
    },
    logs,
    metadata: {
      serviceType: 'worker',
      stateVerified: true
    }
  };
};

/**
 * Descriptor for POSIX worker check handler
 */
export const workerCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'worker',
  handler: checkWorkerProcess
};