import * as fs from 'fs';
import * as path from 'path';
import { PosixStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { killProcessGroupAndRelated, isProcessRunning } from '../utils/process-manager.js';

/**
 * Stop handler for frontend services on POSIX systems
 *
 * Stops the frontend Node.js process gracefully using the PID file
 * stored in the frontend source directory
 */
const stopFrontendService = async (context: PosixStopHandlerContext): Promise<StopHandlerResult> => {
  const { service } = context;
  
  // Get semiont repo path
  const semiontRepo = context.options?.semiontRepo || process.env.SEMIONT_REPO;
  if (!semiontRepo) {
    return {
      success: false,
      error: 'Semiont repository path is required. Use --semiont-repo or set SEMIONT_REPO environment variable',
      metadata: { serviceType: 'frontend' }
    };
  }

  // Setup paths - all in source directory now
  const frontendSourceDir = path.join(semiontRepo, 'apps', 'frontend');
  const pidFile = path.join(frontendSourceDir, '.pid');
  const logsDir = path.join(frontendSourceDir, 'logs');
  const appLogPath = path.join(logsDir, 'app.log');
  const errorLogPath = path.join(logsDir, 'error.log');
  
  // Check if frontend source directory exists
  if (!fs.existsSync(frontendSourceDir)) {
    return {
      success: false,
      error: 'Frontend not found',
      metadata: { serviceType: 'frontend', frontendSourceDir }
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
        if (!isProcessRunning(pid)) {
          throw new Error('Process not running');
        }
        
        // Process is running, try to stop it
        if (!service.quiet) {
          printInfo(`Stopping frontend process (PID ${pid} from saved state)...`);
        }
        
        // Use enhanced killing method
        await killProcessGroupAndRelated(pid, 'frontend', service.verbose);
        
        if (!service.quiet) {
          printSuccess(`✅ Frontend service ${service.name} stopped successfully`);
        }
        
        return {
          success: true,
          metadata: {
            serviceType: 'frontend',
            pid,
            fromSavedState: true
          }
        };
      } catch {
        // Process not running
        return {
          success: true,
          metadata: {
            serviceType: 'frontend',
            message: 'Frontend was not running'
          }
        };
      }
    }
    
    return {
      success: true,
      metadata: {
        serviceType: 'frontend',
        message: 'Frontend is not running (no PID file found)'
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
      metadata: { serviceType: 'frontend', pidFile }
    };
  }
  
  // Check if process is actually running
  if (!isProcessRunning(pid)) {
    // Process not running, just clean up PID file
    fs.unlinkSync(pidFile);
    
    if (!service.quiet) {
      printInfo('Frontend was not running (stale PID file removed)');
    }
    
    return {
      success: true,
      metadata: {
        serviceType: 'frontend',
        message: 'Cleaned up stale PID file'
      }
    };
  }
  
  if (!service.quiet) {
    printInfo(`Stopping frontend service ${service.name} (PID ${pid})...`);
  }
  
  // Write shutdown marker to logs
  const shutdownMessage = `\n=== Frontend Shutdown Initiated at ${new Date().toISOString()} ===\n`;
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
    // Use enhanced killing method with process group support
    const graceful = await killProcessGroupAndRelated(pid, 'frontend', service.verbose);
    
    // Clean up PID file
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    
    // No need to clean up .env.local - it's a real file now, not a symlink
    
    // Write final log entry
    const finalMessage = `\n=== Frontend Stopped at ${new Date().toISOString()} ===\n`;
    try {
      if (fs.existsSync(appLogPath)) {
        fs.appendFileSync(appLogPath, finalMessage);
      }
    } catch {
      // Log writing is best-effort
    }
    
    if (!service.quiet) {
      printSuccess(`✅ Frontend service ${service.name} stopped successfully`);
      
      // Show log locations for debugging
      if (service.verbose) {
        printInfo('');
        printInfo('Log files:');
        printInfo(`  App log: ${appLogPath}`);
        printInfo(`  Error log: ${errorLogPath}`);
      }
    }
    
    return {
      success: true,
      metadata: {
        serviceType: 'frontend',
        pid,
        frontendSourceDir,
        graceful
      }
    };
    
  } catch (error) {
    return {
      success: false,
      error: `Failed to stop frontend: ${error}`,
      metadata: {
        serviceType: 'frontend',
        pid,
        error: (error as Error).toString()
      }
    };
  }
};

/**
 * Descriptor for frontend POSIX stop handler
 */
export const frontendStopDescriptor: HandlerDescriptor<PosixStopHandlerContext, StopHandlerResult> = {
  command: 'stop',
  platform: 'posix',
  serviceType: 'frontend',
  handler: stopFrontendService
};