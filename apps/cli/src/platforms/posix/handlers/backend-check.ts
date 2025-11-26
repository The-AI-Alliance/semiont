import * as fs from 'fs';
import { PosixCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { StateManager } from '../../../core/state-manager.js';
import { getBackendPaths } from './backend-paths.js';
import type { BackendServiceConfig } from '@semiont/core';
import { SemiontApiClient, baseUrl } from '@semiont/api-client';

/**
 * Check handler for backend services on POSIX systems
 *
 * Checks if the backend process is running, verifies health endpoint,
 * and collects recent logs.
 */
const checkBackendService = async (context: PosixCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service, savedState } = context;

  // Type narrowing for backend service config
  const config = service.config as BackendServiceConfig;

  // Get backend paths
  const paths = getBackendPaths(context);
  const { sourceDir: backendDir, pidFile, appLogFile: appLogPath, errorLogFile: errorLogPath } = paths;
  
  let status: 'running' | 'stopped' | 'unknown' | 'unhealthy' = 'stopped';
  let pid: number | undefined;
  let healthy = false;
  let details: Record<string, unknown> = {
    backendDir,
    port: config.port
  };
  
  // Check if backend directory exists
  if (!fs.existsSync(backendDir)) {
    details.message = 'Backend not provisioned';
    return {
      success: true,
      status: 'stopped',
      health: { healthy: false, details },
      metadata: { serviceType: 'backend' }
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
      const port = config.port;
      if (await isPortInUse(port)) {
        status = 'unknown';
        details.message = `Port ${port} is in use (backend may be running outside of semiont)`;
      }
    }
  }
  
  // If running, check health endpoint using API client
  // Use localhost for POSIX platform (publicURL may require external auth in environments like Codespaces)
  if (status === 'running' || status === 'unknown') {
    const localUrl = `http://localhost:${config.port}`;
    const client = new SemiontApiClient({ baseUrl: baseUrl(localUrl) });

    try {
      const healthData = await client.healthCheck();
      healthy = true;
      details.health = healthData;
      details.message = 'Backend is running and healthy';

      // Get API info
      try {
        const apiResponse = await fetch(`${localUrl}/api`, {
          signal: AbortSignal.timeout(2000)
        });
        if (apiResponse.ok) {
          details.apiAvailable = true;
        }
      } catch {
        // API endpoint might not exist
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
      port: config.port,
      path: backendDir,
      workingDirectory: backendDir,
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
      serviceType: 'backend',
      backendDir,
      port: config.port
    }
  };
};

/**
 * Descriptor for backend POSIX check handler
 */
export const backendCheckDescriptor: HandlerDescriptor<PosixCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'backend',
  handler: checkBackendService
};