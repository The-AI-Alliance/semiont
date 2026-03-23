import * as fs from 'fs';
import * as path from 'path';
import { PosixStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { killProcessGroupAndRelated } from '../utils/process-manager.js';
import { passingPreflight } from '../../../core/handlers/preflight-utils.js';
import { resolveBackendNpmPackage } from './backend-paths.js';
import { SemiontProject } from '@semiont/core/node';

/**
 * Stop handler for backend services on POSIX systems
 *
 * Stops the backend Node.js process gracefully using the PID file
 * stored in the backend source directory
 */
const stopBackendService = async (context: PosixStopHandlerContext): Promise<StopHandlerResult> => {
  const { service } = context;

  const projectRoot = service.projectRoot;
  const npmDir = resolveBackendNpmPackage(projectRoot);
  const entryPoint = npmDir ? path.join(npmDir, 'dist', 'index.js') : null;
  const project = new SemiontProject(projectRoot);
  const pidFile = project.backendPidFile;
  const appLogPath = project.backendAppLogFile;
  const errorLogPath = project.backendErrorLogFile;

  if (service.verbose) {
    printInfo(`Entry point: ${entryPoint}`);
  }

  // Check if backend entry point exists (i.e. package is installed)
  if (!entryPoint || !fs.existsSync(entryPoint)) {
    return {
      success: false,
      error: 'Backend not found',
      metadata: { serviceType: 'backend', entryPoint }
    };
  }
  
  // Check for PID file
  if (!fs.existsSync(pidFile)) {
    // Check if we have saved state with PID
    if (context.savedState?.resources?.platform === 'posix' && 
        context.savedState.resources.data.pid) {
      const pid = context.savedState.resources.data.pid;
      
      try {
        // Check if process is running
        process.kill(pid, 0);
        
        // Process is running, try to stop it
        if (!service.quiet) {
          printInfo(`Stopping backend process (PID ${pid} from saved state)...`);
        }
        
        // Use enhanced killing method
        await killProcessGroupAndRelated(pid, 'backend', service.verbose);
        
        if (!service.quiet) {
          printSuccess(`✅ Backend service ${service.name} stopped successfully`);
        }
        
        return {
          success: true,
          metadata: {
            serviceType: 'backend',
            pid,
            fromSavedState: true
          }
        };
      } catch {
        // Process not running
        return {
          success: true,
          metadata: {
            serviceType: 'backend',
            message: 'Backend was not running'
          }
        };
      }
    }
    
    return {
      success: true,
      metadata: {
        serviceType: 'backend',
        message: 'Backend is not running (no PID file found)'
      }
    };
  }
  
  // Read PID from file
  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf-8'));
  } catch (error) {
    return {
      success: false,
      error: `Failed to read PID file: ${error}`,
      metadata: { serviceType: 'backend', pidFile }
    };
  }
  
  // Check if process is actually running
  try {
    process.kill(pid, 0);
  } catch {
    // Process not running, just clean up PID file
    fs.unlinkSync(pidFile);
    
    if (!service.quiet) {
      printInfo('Backend was not running (stale PID file removed)');
    }
    
    return {
      success: true,
      metadata: {
        serviceType: 'backend',
        message: 'Cleaned up stale PID file'
      }
    };
  }
  
  if (!service.quiet) {
    printInfo(`Stopping backend service ${service.name} (PID ${pid})...`);
  }
  
  // Write shutdown marker to logs
  const shutdownMessage = `\n=== Backend Shutdown Initiated at ${new Date().toISOString()} ===\n`;
  try {
    if (fs.existsSync(appLogPath)) {
      fs.appendFileSync(appLogPath, shutdownMessage);
    }
    if (fs.existsSync(errorLogPath)) {
      fs.appendFileSync(errorLogPath, shutdownMessage);
    }
  } catch {
    // Log writing is best-effort
  }
  
  try {
    // Use enhanced killing method
    const killed = await killProcessGroupAndRelated(pid, 'backend', service.verbose);
    
    // Clean up PID file
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    
    // Write final log entry
    const finalMessage = `\n=== Backend Stopped at ${new Date().toISOString()} ===\n`;
    try {
      if (fs.existsSync(appLogPath)) {
        fs.appendFileSync(appLogPath, finalMessage);
      }
    } catch {
      // Log writing is best-effort
    }
    
    if (!service.quiet) {
      printSuccess(`✅ Backend service ${service.name} stopped successfully`);
      printInfo(`  App log: ${appLogPath}`);
      printInfo(`  Error log: ${errorLogPath}`);
    }
    
    return {
      success: true,
      metadata: {
        serviceType: 'backend',
        pid,
        entryPoint,
        graceful: killed
      }
    };
    
  } catch (error) {
    return {
      success: false,
      error: `Failed to stop backend: ${error}`,
      metadata: {
        serviceType: 'backend',
        pid,
        error: (error as Error).toString()
      }
    };
  }
};

/**
 * Descriptor for backend POSIX stop handler
 */
export const backendStopDescriptor: HandlerDescriptor<PosixStopHandlerContext, StopHandlerResult> = {
  command: 'stop',
  platform: 'posix',
  serviceType: 'backend',
  handler: stopBackendService,
  preflight: async () => passingPreflight()
};