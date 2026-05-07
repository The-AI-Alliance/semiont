import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { PosixCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { StateManager } from '../../../core/state-manager.js';
import { resolveFrontendNpmPackage, resolveFrontendServerScript, frontendXdgPaths } from './frontend-paths.js';
import type { FrontendServiceConfig } from '@semiont/core';
import { checkConfigPort, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';

/**
 * Check handler for frontend services on POSIX systems
 *
 * Checks if the frontend process is running, verifies health endpoint,
 * and collects recent logs.
 */
const checkFrontendService = async (context: PosixCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service, savedState } = context;

  const config = service.config as FrontendServiceConfig;

  const npmDir = resolveFrontendNpmPackage();
  const serverScript = npmDir ? (resolveFrontendServerScript() ?? path.join(npmDir, 'server.js')) : null;
  const { pidFile, appLogFile, errorLogFile } = frontendXdgPaths();

  let status: 'running' | 'stopped' | 'unknown' | 'unhealthy' = 'stopped';
  let pid: number | undefined;
  let healthy = false;
  let details: Record<string, unknown> = {
    serverScript,
    port: config.port,
    source: 'npm package',
    pidFile,
    appLog: appLogFile,
    errorLog: errorLogFile,
  };

  // Check if frontend server script exists (i.e. package is installed)
  if (!serverScript || !fs.existsSync(serverScript)) {
    details.message = 'Frontend package not found — reinstall @semiont/cli';
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
        details.message = `Port ${port} is in use (frontend may be running outside of semiont)`;
      }
    }
  }

  // If running, check health endpoint
  if (status === 'unhealthy' || status === 'unknown') {
    const healthUrl = `http://localhost:${config.port}`;

    try {
      const response = await fetch(healthUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        healthy = true;
        status = 'running';
        details.message = 'Frontend is running and healthy';
        details.statusCode = response.status;

        const contentType = response.headers.get('content-type');
        if (contentType?.includes('text/html')) {
          details.htmlAvailable = true;
        }
      } else {
        details.message = `Health check failed with status ${response.status}`;
        details.healthStatus = response.status;
      }
    } catch (error) {
      details.message = 'Process is running but health check failed';
      details.healthError = (error as Error).toString();
    }
  }

  // Collect recent logs
  let logs: { recent: string[]; errors: string[] } | undefined;
  if (fs.existsSync(appLogFile)) {
    try {
      const recentLogs = execFileSync('tail', ['-10', appLogFile], { encoding: 'utf-8' })
        .split('\n')
        .filter((line: string) => line.trim());

      let errorLogs: string[] = [];
      if (fs.existsSync(errorLogFile)) {
        errorLogs = execFileSync('tail', ['-5', errorLogFile], { encoding: 'utf-8' })
          .split('\n')
          .filter((line: string) => line.trim());
      }

      logs = {
        recent: recentLogs,
        errors: errorLogs
      };

      const appLogStats = fs.statSync(appLogFile);
      const errorLogStats = fs.existsSync(errorLogFile) ? fs.statSync(errorLogFile) : null;

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
      path: serverScript ?? undefined,
      workingDirectory: serverScript ?? undefined,
      logFile: appLogFile
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
      serverScript,
      port: config.port
    }
  };
};

const preflightFrontendCheck = async (context: PosixCheckHandlerContext) => {
  const config = context.service.config as FrontendServiceConfig;
  return preflightFromChecks([checkConfigPort(config.port, 'frontend.port')]);
};

/**
 * Descriptor for frontend POSIX check handler
 */
export const frontendCheckDescriptor: HandlerDescriptor<PosixCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'frontend',
  handler: checkFrontendService,
  preflight: preflightFrontendCheck
};
