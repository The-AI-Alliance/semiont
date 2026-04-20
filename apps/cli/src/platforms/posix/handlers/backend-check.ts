import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { PosixCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { StateManager } from '../../../core/state-manager.js';
import { resolveBackendNpmPackage, resolveBackendEntryPoint } from './backend-paths.js';
import { SemiontProject } from '@semiont/core/node';
import type { BackendServiceConfig } from '@semiont/core';
import { baseUrl } from '@semiont/core';
import { SemiontApiClient } from '@semiont/api-client';
import { checkConfigPort, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';

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

  const projectRoot = service.projectRoot!;
  const project = new SemiontProject(projectRoot);
  const installPrefix = project.dataHome;
  const npmDir = resolveBackendNpmPackage(installPrefix);
  const entryPoint = npmDir ? (resolveBackendEntryPoint(installPrefix) ?? path.join(npmDir, 'dist', 'index.js')) : null;
  const pidFile = project.backendPidFile;
  const appLogPath = project.backendAppLogFile;
  const errorLogPath = project.backendErrorLogFile;

  let status: 'running' | 'stopped' | 'unknown' | 'unhealthy' = 'stopped';
  let pid: number | undefined;
  let healthy = false;
  let details: Record<string, unknown> = {
    entryPoint,
    port: config.port,
    source: 'npm package',
    pidFile,
    appLog: appLogPath,
    errorLog: errorLogPath,
  };

  // Check if backend entry point exists (i.e. package is installed)
  if (!entryPoint || !fs.existsSync(entryPoint)) {
    details.message = 'Backend not provisioned';
    return {
      success: true,
      status: 'stopped',
      provisioned: false,
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
      status = 'unhealthy';  // Upgraded to 'running' only after HTTP health check passes
      details.pid = pid;
      
      // Get process info
      try {
        const psOutput = execFileSync('ps', ['-p', String(pid), '-o', 'comm=,rss=,pcpu='], { encoding: 'utf-8' }).trim();
        
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
      status = 'unhealthy';  // Upgraded to 'running' only after HTTP health check passes
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
  if (status === 'unhealthy' || status === 'unknown') {
    const localUrl = `http://localhost:${config.port}`;
    const client = new SemiontApiClient({ baseUrl: baseUrl(localUrl) });

    try {
      const healthData = await client.healthCheck();
      healthy = true;
      status = 'running';
      details.health = healthData;
      details.message = 'Backend is running and healthy';
    } catch (error) {
      details.message = 'Process is running but health check failed';
      details.healthError = (error as Error).toString();
    }
  }
  
  // Collect recent logs
  let logs: { recent: string[]; errors: string[] } | undefined;
  if (fs.existsSync(appLogPath)) {
    try {
      // Get last 10 lines of app log
      const recentLogs = execFileSync('tail', ['-10', appLogPath], { encoding: 'utf-8' })
        .split('\n')
        .filter((line: string) => line.trim());

      // Get last 5 error lines
      let errorLogs: string[] = [];
      if (fs.existsSync(errorLogPath)) {
        errorLogs = execFileSync('tail', ['-5', errorLogPath], { encoding: 'utf-8' })
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
      path: entryPoint ?? undefined,
      workingDirectory: entryPoint ?? undefined,
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
      entryPoint,
      port: config.port
    }
  };
};

const preflightBackendCheck = async (context: PosixCheckHandlerContext) => {
  const config = context.service.config as BackendServiceConfig;
  return preflightFromChecks([checkConfigPort(config.port, 'backend.port')]);
};

/**
 * Descriptor for backend POSIX check handler
 */
export const backendCheckDescriptor: HandlerDescriptor<PosixCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'backend',
  handler: checkBackendService,
  preflight: preflightBackendCheck
};