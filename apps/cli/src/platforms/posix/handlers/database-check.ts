import { StateManager } from '../../../core/state-manager.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { execSync } from 'child_process';
import { PosixCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';

/**
 * Check handler for POSIX database services
 */
const checkDatabaseProcess = async (context: PosixCheckHandlerContext): Promise<CheckHandlerResult> => {
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
  
  // Check if saved process is running
  if (savedState?.resources?.platform === 'posix' && 
      savedState.resources.data.pid && 
      StateManager.isProcessRunning(savedState.resources.data.pid)) {
    pid = savedState.resources.data.pid;
    status = 'running';
  } else {
    // Check standard database ports
    const dbPorts: Record<string, number> = {
      postgres: 5432,
      postgresql: 5432,
      mysql: 3306,
      mongodb: 27017,
      redis: 6379
    };
    
    const serviceName = service.name.toLowerCase();
    const defaultPort = dbPorts[serviceName];
    const port = requirements.network?.ports?.[0] || defaultPort;
    
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
          // Database is running but we couldn't determine the PID
        }
      } catch {
        status = 'running';
        // Database is running but we couldn't determine the PID
      }
    }
  }
  
  // Basic database health check - just check if port is responding
  let health = {
    healthy: status === 'running',
    details: {
      port: requirements.network?.ports?.[0],
      status: status === 'running' ? 'accepting connections' : 'not running'
    }
  };
  
  const platformResources = pid ? {
    platform: 'posix' as const,
    data: {
      pid,
      port: requirements.network?.ports?.[0]
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
    health,
    logs,
    metadata: {
      serviceType: 'database',
      stateVerified: true
    }
  };
};

/**
 * Descriptor for POSIX database check handler
 */
export const databaseCheckDescriptor: HandlerDescriptor<PosixCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'database',
  handler: checkDatabaseProcess
};