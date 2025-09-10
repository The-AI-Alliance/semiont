import * as fs from 'fs';
import * as path from 'path';
import { PosixStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';

/**
 * Stop handler for frontend services on POSIX systems
 * 
 * Stops the frontend Node.js process gracefully using the PID file
 * stored in SEMIONT_ROOT/frontend/.pid
 */
const stopFrontendService = async (context: PosixStopHandlerContext): Promise<StopHandlerResult> => {
  const { service } = context;
  
  // Setup paths
  const frontendDir = path.join(service.projectRoot, 'frontend');
  const pidFile = path.join(frontendDir, '.pid');
  const logsDir = path.join(frontendDir, 'logs');
  const appLogPath = path.join(logsDir, 'app.log');
  const errorLogPath = path.join(logsDir, 'error.log');
  
  // Check if frontend directory exists
  if (!fs.existsSync(frontendDir)) {
    return {
      success: false,
      error: 'Frontend not provisioned',
      metadata: { serviceType: 'frontend', frontendDir }
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
          printInfo(`Stopping frontend process (PID ${pid} from saved state)...`);
        }
        
        // Send SIGTERM for graceful shutdown
        process.kill(pid, 'SIGTERM');
        
        // Wait for process to terminate (up to 10 seconds)
        let terminated = false;
        for (let i = 0; i < 20; i++) {
          await new Promise(resolve => setTimeout(resolve, 500));
          try {
            process.kill(pid, 0);
          } catch {
            terminated = true;
            break;
          }
        }
        
        if (!terminated) {
          // Force kill if not terminated
          if (!service.quiet) {
            printWarning('Process did not terminate gracefully, forcing...');
          }
          process.kill(pid, 'SIGKILL');
        }
        
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
  try {
    process.kill(pid, 0);
  } catch {
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
    // Send SIGTERM for graceful shutdown
    process.kill(pid, 'SIGTERM');
    
    // Wait for process to terminate (up to 10 seconds)
    let terminated = false;
    let waitTime = 0;
    const maxWaitTime = 10000;
    const checkInterval = 500;
    
    while (waitTime < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waitTime += checkInterval;
      
      try {
        // Check if process still exists
        process.kill(pid, 0);
      } catch {
        // Process no longer exists
        terminated = true;
        break;
      }
      
      if (service.verbose && waitTime % 2000 === 0) {
        printInfo(`Waiting for frontend to shut down... (${waitTime / 1000}s)`);
      }
    }
    
    if (!terminated) {
      // Force kill if not terminated gracefully
      if (!service.quiet) {
        printWarning('Frontend did not terminate gracefully, forcing shutdown...');
      }
      
      process.kill(pid, 'SIGKILL');
      
      // Wait a moment for force kill to take effect
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Verify it's really gone
      try {
        process.kill(pid, 0);
        throw new Error('Process survived SIGKILL');
      } catch (e) {
        if ((e as Error).message === 'Process survived SIGKILL') {
          throw e;
        }
        // Process is gone, good
      }
    }
    
    // Clean up PID file
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    
    // Clean up .env.local symlink in source directory
    const semiontRepo = process.env.SEMIONT_REPO || path.resolve(service.projectRoot, '..', 'github.com', 'The-AI-Alliance', 'semiont');
    const sourceEnvFile = path.join(semiontRepo, 'apps', 'frontend', '.env.local');
    if (fs.existsSync(sourceEnvFile)) {
      try {
        const stats = fs.lstatSync(sourceEnvFile);
        if (stats.isSymbolicLink()) {
          fs.unlinkSync(sourceEnvFile);
        }
      } catch {
        // Ignore errors cleaning up symlink
      }
    }
    
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
        frontendDir,
        graceful: terminated
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