import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { StartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { PlatformResources } from '../../platform-resources.js';
import { isPortInUse } from '../../../core/io/network-utils.js';

/**
 * Start handler for filesystem services on POSIX systems
 */
const startFilesystemService = async (context: StartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const requirements = service.getRequirements();
  const command = service.getCommand();
  
  // Check if filesystem service needs a port (e.g., file server)
  const primaryPort = requirements.network?.ports?.[0];
  if (primaryPort && await isPortInUse(primaryPort)) {
    return {
      success: false,
      error: `Port ${primaryPort} is already in use`,
      metadata: {
        serviceType: 'filesystem',
        port: primaryPort
      }
    };
  }
  
  // Ensure required directories exist
  const mountPaths: string[] = [];
  if (requirements.storage) {
    for (const storage of requirements.storage) {
      const mountPath = storage.mountPath || path.join(process.cwd(), 'data', service.name, storage.name || 'default');
      fs.mkdirSync(mountPath, { recursive: true });
      mountPaths.push(mountPath);
    }
  }
  
  // Build environment from requirements
  const env = {
    ...process.env,
    ...service.getEnvironmentVariables(),
    ...(requirements.environment || {}),
    NODE_ENV: service.environment
  };
  
  // Add filesystem-specific environment variables
  if (mountPaths.length > 0) {
    (env as any).DATA_PATH = mountPaths[0];
    (env as any).MOUNT_PATHS = mountPaths.join(':');
  }
  
  // Add port if specified
  if (primaryPort) {
    (env as any).PORT = primaryPort.toString();
  }
  
  // Add filesystem service configuration
  if (requirements.filesystem) {
    if (requirements.filesystem.watchPaths) {
      (env as any).WATCH_PATHS = requirements.filesystem.watchPaths.join(':');
    }
    if (requirements.filesystem.syncInterval) {
      (env as any).SYNC_INTERVAL = requirements.filesystem.syncInterval.toString();
    }
    if (requirements.filesystem.maxFileSize) {
      (env as any).MAX_FILE_SIZE = requirements.filesystem.maxFileSize;
    }
  }
  
  // Parse command
  const [cmd, ...args] = command.split(' ');
  
  // For process platform, run commands in the current directory
  const workingDir = process.cwd();
  
  // Filesystem services may need detailed logging
  let stdio: any;
  if (service.quiet) {
    stdio = ['ignore', 'ignore', 'pipe']; // Still capture stderr
  } else if (service.verbose) {
    stdio = 'inherit';
  } else {
    stdio = ['ignore', 'pipe', 'pipe'];
  }
  
  try {
    const proc = spawn(cmd, args, {
      cwd: workingDir,
      env,
      detached: true,
      stdio
    });
    
    if (!proc.pid) {
      throw new Error('Failed to start filesystem process');
    }
    
    // Log errors
    if (Array.isArray(stdio) && stdio[2] === 'pipe' && proc.stderr) {
      proc.stderr.on('data', (data) => {
        console.error(`[${service.name}] ${data.toString()}`);
      });
    }
    
    // Log filesystem operations if verbose
    if (Array.isArray(stdio) && stdio[1] === 'pipe' && proc.stdout && !service.quiet) {
      proc.stdout.on('data', (data) => {
        const msg = data.toString();
        if (service.verbose || msg.includes('ERROR') || msg.includes('WARN')) {
          console.log(`[${service.name}] ${msg}`);
        }
      });
    }
    
    proc.unref();
    
    // Build endpoint if this is a file server
    let endpoint: string | undefined;
    if (primaryPort) {
      endpoint = `http://localhost:${primaryPort}`;
    }
    
    const resources: PlatformResources = {
      platform: 'posix',
      data: {
        pid: proc.pid,
        port: primaryPort,
        command,
        workingDirectory: workingDir,
        path: mountPaths[0]  // Primary mount path
      }
    };
    
    return {
      success: true,
      endpoint,
      resources,
      metadata: {
        serviceType: 'filesystem',
        command,
        pid: proc.pid,
        port: primaryPort,
        mountPaths,
        watchPaths: requirements.filesystem?.watchPaths,
        stdio: service.quiet ? 'minimal' : (service.verbose ? 'inherit' : 'pipe')
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to start filesystem service: ${error}`,
      metadata: {
        serviceType: 'filesystem',
        command
      }
    };
  }
};

/**
 * Descriptor for filesystem service start handler
 */
export const filesystemStartDescriptor: HandlerDescriptor<StartHandlerContext, StartHandlerResult> = {
  command: 'start',
  serviceType: 'filesystem',
  handler: startFilesystemService
};