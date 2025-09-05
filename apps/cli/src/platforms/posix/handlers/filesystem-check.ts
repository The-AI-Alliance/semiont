import { StateManager } from '../../../core/state-manager.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { PosixCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';

/**
 * Check handler for POSIX filesystem services (NFS, Samba, etc.)
 */
const checkFilesystemProcess = async (context: PosixCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service, savedState } = context;
  const requirements = service.getRequirements();
  
  let status: 'running' | 'stopped' = 'stopped';
  let pid: number | undefined;
  
  // Check if saved process is running
  if (savedState?.resources?.platform === 'posix' && 
      savedState.resources.data.pid && 
      StateManager.isProcessRunning(savedState.resources.data.pid)) {
    pid = savedState.resources.data.pid;
    status = 'running';
  } else {
    // Check standard filesystem service ports
    const fsPorts: Record<string, number[]> = {
      nfs: [2049, 111], // NFS and portmapper
      samba: [445, 139],
      webdav: [80, 443]
    };
    
    const serviceName = service.name.toLowerCase();
    const defaultPorts = fsPorts[serviceName] || [];
    const port = requirements.network?.ports?.[0] || defaultPorts[0];
    
    if (port && await isPortInUse(port)) {
      status = 'running';
    }
  }
  
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
    health: {
      healthy: status === 'running',
      details: {
        message: status === 'running' ? 'Filesystem service is running' : 'Filesystem service is stopped'
      }
    },
    logs,
    metadata: {
      serviceType: 'filesystem',
      stateVerified: true
    }
  };
};

/**
 * Descriptor for POSIX filesystem check handler
 */
export const filesystemCheckDescriptor: HandlerDescriptor<PosixCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'filesystem',
  handler: checkFilesystemProcess
};