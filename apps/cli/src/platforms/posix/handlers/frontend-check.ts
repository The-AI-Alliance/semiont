import * as fs from 'fs';
import * as path from 'path';
import { PosixCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { StateManager } from '../../../core/state-manager.js';

/**
 * Check handler for frontend services on POSIX systems
 * 
 * Checks if the frontend process is running, verifies health endpoint,
 * and collects recent logs.
 */
const checkFrontendService = async (context: PosixCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service, savedState } = context;
  
  // Setup paths
  const frontendDir = path.join(service.projectRoot, 'frontend');
  const pidFile = path.join(frontendDir, '.pid');
  const logsDir = path.join(frontendDir, 'logs');
  const appLogPath = path.join(logsDir, 'app.log');
  const errorLogPath = path.join(logsDir, 'error.log');
  
  let status: 'running' | 'stopped' | 'unknown' | 'unhealthy' = 'stopped';
  let pid: number | undefined;
  let healthy = false;
  let details: any = {
    frontendDir,
    port: service.config.port || 3000
  };
  
  // Check if frontend directory exists
  if (!fs.existsSync(frontendDir)) {
    details.message = 'Frontend not provisioned';
    return {
      success: true,
      status: 'stopped',
      health: { healthy: false, details },
      metadata: { serviceType: 'frontend' }
    };
  }
  
  // Check for PID file
  if (fs.existsSync(pidFile)) {
    try {
      pid = parseInt(fs.readFileSync(pidFile, 'utf-8'));
      
      // Check if process is running
      process.kill(pid, 0);
      status = 'running';
      details.pid = pid;
      
      // Get process info
      try {
        const psOutput = require('child_process')
          .execSync(`ps -p ${pid} -o comm=,rss=,pcpu=`, { encoding: 'utf-8' })
          .trim();
        
        if (psOutput) {
          const [command, rss, cpu] = psOutput.split(/\s+/);
          details.process = {
            command,
            memory: `${Math.round(parseInt(rss) / 1024)} MB`,
            cpu: `${cpu}%`
          };
        }
      } catch {
        // ps command might fail on some systems
      }
    } catch {
      // Process not running, stale PID file
      status = 'stopped';
      details.message = 'Stale PID file found (process not running)';
      
      // Clean up stale PID file
      fs.unlinkSync(pidFile);
    }
  } else {
    // Check if process is running from saved state
    if (savedState?.resources?.platform === 'posix' && 
        savedState.resources.data.pid && 
        StateManager.isProcessRunning(savedState.resources.data.pid)) {
      pid = savedState.resources.data.pid;
      status = 'running';
      details.pid = pid;
      details.fromSavedState = true;
    } else {
      // Check if port is in use (might be running outside of semiont)
      const port = service.config.port || 3000;
      if (await isPortInUse(port)) {
        status = 'unknown';
        details.message = `Port ${port} is in use (frontend may be running outside of semiont)`;
      }
    }
  }
  
  // If running, check health endpoint
  if (status === 'running' || status === 'unknown') {
    const port = service.config.port || 3000;
    const healthUrl = `http://localhost:${port}/`;
    
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(5000)
      });
      
      if (response.ok) {
        healthy = true;
        details.message = 'Frontend is running and healthy';
        details.statusCode = response.status;
        
        // Check if Next.js is responding
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('text/html')) {
          details.framework = 'Next.js';
          details.htmlAvailable = true;
        }
        
        // Try to check API endpoint
        try {
          const apiResponse = await fetch(`http://localhost:${port}/api/health`, {
            signal: AbortSignal.timeout(2000)
          });
          if (apiResponse.ok) {
            details.apiRouteAvailable = true;
          }
        } catch {
          // API route might not exist
        }
      } else {
        status = 'unhealthy';
        details.message = `Health check failed with status ${response.status}`;
        details.healthStatus = response.status;
      }
    } catch (error) {
      if (status === 'running') {
        status = 'unhealthy';
        details.message = 'Process is running but health check failed';
        details.healthError = (error as Error).toString();
      }
    }
  }
  
  // Collect recent logs
  let logs: { recent: string[]; errors: string[] } | undefined;
  if (fs.existsSync(appLogPath)) {
    try {
      const { execSync } = require('child_process');
      
      // Get last 10 lines of app log
      const recentLogs = execSync(`tail -10 "${appLogPath}"`, { encoding: 'utf-8' })
        .split('\n')
        .filter((line: string) => line.trim());
      
      // Get last 5 error lines
      let errorLogs: string[] = [];
      if (fs.existsSync(errorLogPath)) {
        errorLogs = execSync(`tail -5 "${errorLogPath}"`, { encoding: 'utf-8' })
          .split('\n')
          .filter((line: string) => line.trim());
      }
      
      logs = {
        recent: recentLogs,
        errors: errorLogs
      };
      
      // Get log file sizes
      const appLogStats = fs.statSync(appLogPath);
      const errorLogStats = fs.existsSync(errorLogPath) ? fs.statSync(errorLogPath) : null;
      
      details.logs = {
        appLogSize: `${Math.round(appLogStats.size / 1024)} KB`,
        errorLogSize: errorLogStats ? `${Math.round(errorLogStats.size / 1024)} KB` : '0 KB',
        lastModified: appLogStats.mtime
      };
    } catch {
      // Log collection is best-effort
    }
  }
  
  // Build platform resources
  const platformResources = pid ? {
    platform: 'posix' as const,
    data: {
      pid,
      port: service.config.port || 3000,
      path: frontendDir,
      workingDirectory: frontendDir,
      logFile: appLogPath
    }
  } : undefined;
  
  return {
    success: true,
    status,
    platformResources,
    health: {
      healthy,
      details
    },
    logs,
    metadata: {
      serviceType: 'frontend',
      frontendDir,
      port: service.config.port || 3000
    }
  };
};

/**
 * Descriptor for frontend POSIX check handler
 */
export const frontendCheckDescriptor: HandlerDescriptor<PosixCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'frontend',
  handler: checkFrontendService
};