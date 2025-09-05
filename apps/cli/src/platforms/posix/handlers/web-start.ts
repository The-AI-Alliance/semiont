import { spawn } from 'child_process';
import { PosixStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { PlatformResources } from '../../platform-resources.js';
import { isPortInUse } from '../../../core/io/network-utils.js';

/**
 * Start handler for web services on POSIX systems
 */
const startWebService = async (context: PosixStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const requirements = service.getRequirements();
  const command = service.getCommand();
  
  // Check network port availability
  const primaryPort = requirements.network?.ports?.[0];
  if (primaryPort && await isPortInUse(primaryPort)) {
    return {
      success: false,
      error: `Port ${primaryPort} is already in use`,
      metadata: {
        serviceType: 'web',
        port: primaryPort
      }
    };
  }
  
  // Build environment from requirements
  const env = {
    ...process.env,
    ...service.getEnvironmentVariables(),
    ...(requirements.environment || {}),
    NODE_ENV: service.environment
  };
  
  // Add port if specified in network requirements
  if (primaryPort) {
    (env as any).PORT = primaryPort.toString();
  }
  
  // Parse command
  const [cmd, ...args] = command.split(' ');
  
  // For process platform, run commands in the current directory
  const workingDir = process.cwd();
  
  // Determine stdio handling
  let stdio: any;
  if (service.quiet) {
    stdio = 'ignore';
  } else if (service.verbose) {
    stdio = 'inherit';
  } else {
    // Default: capture output for logging but don't display
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
      throw new Error('Failed to start web process');
    }
    
    // If we're piping output, log any errors
    if (Array.isArray(stdio) && stdio[2] === 'pipe' && proc.stderr) {
      proc.stderr.on('data', (data) => {
        // Always log errors
        console.error(`[${service.name}] ${data.toString()}`);
      });
    }
    
    proc.unref();
    
    // Build endpoint for web service
    let endpoint: string | undefined;
    if (primaryPort) {
      const protocol = 'http'; // Default to http for process platform
      endpoint = `${protocol}://localhost:${primaryPort}`;
    }
    
    const resources: PlatformResources = {
      platform: 'posix',
      data: {
        pid: proc.pid,
        port: primaryPort,
        command,
        workingDirectory: workingDir
      }
    };
    
    return {
      success: true,
      endpoint,
      resources,
      metadata: {
        serviceType: 'web',
        command,
        pid: proc.pid,
        port: primaryPort,
        stdio: service.quiet ? 'ignore' : (service.verbose ? 'inherit' : 'pipe')
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to start web service: ${error}`,
      metadata: {
        serviceType: 'web',
        command
      }
    };
  }
};

/**
 * Descriptor for web service start handler
 */
export const webStartDescriptor: HandlerDescriptor<PosixStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'posix',
  serviceType: 'web',
  handler: startWebService
};