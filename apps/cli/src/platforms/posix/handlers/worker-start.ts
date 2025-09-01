import { spawn } from 'child_process';
import { StartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { PlatformResources } from '../../platform-resources.js';

/**
 * Start handler for worker services on POSIX systems
 */
const startWorkerService = async (context: StartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const requirements = service.getRequirements();
  const command = service.getCommand();
  
  // Build environment from requirements
  const env = {
    ...process.env,
    ...service.getEnvironmentVariables(),
    ...(requirements.environment || {}),
    NODE_ENV: service.environment
  };
  
  // Add worker-specific environment variables
  if (requirements.worker) {
    if (requirements.worker.concurrency) {
      (env as any).WORKER_CONCURRENCY = requirements.worker.concurrency.toString();
    }
    if (requirements.worker.queueName) {
      (env as any).QUEUE_NAME = requirements.worker.queueName;
    }
    if (requirements.worker.maxRetries) {
      (env as any).MAX_RETRIES = requirements.worker.maxRetries.toString();
    }
  }
  
  // Parse command
  const [cmd, ...args] = command.split(' ');
  
  // For process platform, run commands in the current directory
  const workingDir = process.cwd();
  
  // Worker services typically need logging for monitoring
  let stdio: any;
  if (service.quiet) {
    stdio = ['ignore', 'ignore', 'pipe']; // Still capture stderr for workers
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
      throw new Error('Failed to start worker process');
    }
    
    // Log errors for workers
    if (Array.isArray(stdio) && stdio[2] === 'pipe' && proc.stderr) {
      proc.stderr.on('data', (data) => {
        console.error(`[${service.name}] ${data.toString()}`);
      });
    }
    
    // Log worker activity if not quiet
    if (Array.isArray(stdio) && stdio[1] === 'pipe' && proc.stdout && !service.quiet) {
      proc.stdout.on('data', (data) => {
        const msg = data.toString();
        // Log important worker events
        if (service.verbose || msg.includes('ERROR') || msg.includes('WARN')) {
          console.log(`[${service.name}] ${msg}`);
        }
      });
    }
    
    proc.unref();
    
    const resources: PlatformResources = {
      platform: 'posix',
      data: {
        pid: proc.pid,
        command,
        workingDirectory: workingDir
      }
    };
    
    return {
      success: true,
      resources,
      metadata: {
        serviceType: 'worker',
        workerType: requirements.worker?.type,
        command,
        pid: proc.pid,
        concurrency: requirements.worker?.concurrency,
        queueName: requirements.worker?.queueName,
        stdio: service.quiet ? 'minimal' : (service.verbose ? 'inherit' : 'pipe')
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to start worker service: ${error}`,
      metadata: {
        serviceType: 'worker',
        command
      }
    };
  }
};

/**
 * Descriptor for worker service start handler
 */
export const workerStartDescriptor: HandlerDescriptor<StartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'posix',
  serviceType: 'worker',
  handler: startWorkerService
};